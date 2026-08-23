    #[test]
    fn metadata_orphan_entries_wait_for_authoritative_engine_source() {
        let workspace = workspace_entry("ws-1", "Workspace", "/repo", WorkspaceKind::Main, None);
        let metadata = WorkspaceSessionCatalogMetadata {
            archived_at_by_session_id: HashMap::from([
                ("claude:ws-1:session-1".to_string(), 42),
                ("codex:ws-1:session-2".to_string(), 43),
            ]),
            ..Default::default()
        };
        let mut incomplete_entries = Vec::new();

        append_metadata_orphan_entries(
            &mut incomplete_entries,
            &workspace,
            &metadata,
            &[
                WorkspaceSessionCatalogSourceStatus {
                    engine: "claude".to_string(),
                    source_kind: None,
            completeness: WorkspaceSessionSourceCompleteness::UncertainEmpty,
                    reason: Some(SESSION_CATALOG_PARTIAL_CLAUDE_UNCERTAIN_EMPTY.to_string()),
                    scanned_candidates: Some(0),
                    skipped_candidates: None,
                    scan_cap_reached: Some(false),
                    diagnostics: Vec::new(),
                    cache: None,
                },
                WorkspaceSessionCatalogSourceStatus {
                    engine: "codex".to_string(),
                    source_kind: None,
            completeness: WorkspaceSessionSourceCompleteness::Complete,
                    reason: None,
                    scanned_candidates: Some(0),
                    skipped_candidates: None,
                    scan_cap_reached: Some(false),
                    diagnostics: Vec::new(),
                    cache: None,
                },
            ],
        );

        assert!(!incomplete_entries
            .iter()
            .any(|entry| entry.engine == "claude"));
        assert!(incomplete_entries
            .iter()
            .any(|entry| entry.engine == "codex"));

        let mut authoritative_entries = Vec::new();
        append_metadata_orphan_entries(
            &mut authoritative_entries,
            &workspace,
            &metadata,
            &[WorkspaceSessionCatalogSourceStatus {
                engine: "claude".to_string(),
                source_kind: None,
            completeness: WorkspaceSessionSourceCompleteness::AuthoritativeEmpty,
                reason: None,
                scanned_candidates: Some(0),
                skipped_candidates: None,
                scan_cap_reached: Some(false),
                diagnostics: Vec::new(),
                cache: None,
            }],
        );

        assert!(authoritative_entries
            .iter()
            .any(|entry| entry.engine == "claude"
                && entry.delete_mode.as_deref() == Some(SESSION_DELETE_MODE_METADATA_CLEANUP)));
    }
    #[tokio::test]
    async fn auto_session_metadata_persists_and_projects_visibility() {
        let base = std::env::temp_dir().join(format!("auto-session-metadata-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("create temp dir");
        let storage_path = base.join("workspaces.json");
        std::fs::write(&storage_path, "[]").expect("seed storage path");
        let workspace = workspace_entry("ws-1", "Workspace", "/tmp/ws-1", WorkspaceKind::Main, None);
        let workspaces = Mutex::new(HashMap::from([(workspace.id.clone(), workspace)]));

        record_auto_session_metadata_core(
            &workspaces,
            &storage_path,
            "ws-1".to_string(),
            "codex-hidden".to_string(),
            AutoSessionMetadata {
                session_purpose: "prompt-enhancer".to_string(),
                visibility: AutoSessionVisibility::Hidden,
                owner_feature: "composer".to_string(),
                auto_archive: Some(true),
                created_by: AutoSessionCreatedBy::System,
            },
        )
        .await
        .expect("record hidden metadata");
        record_auto_session_metadata_core(
            &workspaces,
            &storage_path,
            "ws-1".to_string(),
            "codex-traceable".to_string(),
            AutoSessionMetadata {
                session_purpose: "spec-hub-apply".to_string(),
                visibility: AutoSessionVisibility::SystemAuto,
                owner_feature: "spec-hub".to_string(),
                auto_archive: Some(false),
                created_by: AutoSessionCreatedBy::System,
            },
        )
        .await
        .expect("record system-auto metadata");

        let metadata = read_catalog_metadata(&storage_path, "ws-1").expect("read metadata");
        let metadata_by_workspace_id = HashMap::from([("ws-1".to_string(), metadata)]);
        let hidden = finalize_existing_catalog_entry(
            catalog_entry("codex-hidden", "ws-1", Some("Workspace"), None),
            &metadata_by_workspace_id,
        );
        let traceable = finalize_existing_catalog_entry(
            catalog_entry("codex-traceable", "ws-1", Some("Workspace"), None),
            &metadata_by_workspace_id,
        );

        assert!(entry_is_hidden_automatic_session(&hidden));
        assert_eq!(
            traceable.folder_id.as_deref(),
            Some(SESSION_FOLDER_SYSTEM_AUTO_ID)
        );
        assert_eq!(
            traceable
                .auto_session
                .as_ref()
                .map(|metadata| metadata.session_purpose.as_str()),
            Some("spec-hub-apply")
        );

        let page = build_catalog_page(
            vec![hidden.clone(), traceable.clone()],
            WorkspaceSessionCatalogQuery::default(),
            None,
            Some(10),
            None,
            Vec::new(),
            collect_hidden_automatic_session_ids_from_metadata(&metadata_by_workspace_id),
        );
        assert!(
            page.data
                .iter()
                .all(|entry| entry.session_id != "codex-hidden")
        );
        assert!(
            page.hidden_automatic_session_ids
                .iter()
                .any(|id| id == "codex-hidden" || id.contains("codex-hidden"))
        );
        assert!(page
            .hidden_automatic_session_ids
            .iter()
            .any(|id| id.contains("codex-hidden")));

        std::fs::remove_dir_all(base).ok();
    }

    #[tokio::test]
    async fn qoder_auto_session_metadata_keeps_same_raw_id_per_distribution() {
        let base = std::env::temp_dir().join(format!("qoder-auto-session-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("create temp dir");
        let storage_path = base.join("workspaces.json");
        std::fs::write(&storage_path, "[]").expect("seed storage path");
        let workspace = workspace_entry("ws-1", "Workspace", "/tmp/ws-1", WorkspaceKind::Main, None);
        let workspaces = Mutex::new(HashMap::from([(workspace.id.clone(), workspace)]));
        let global_id = "qoder:__qoder_global__:same-raw-session";
        let cn_id = "qoder:__qoder_cn__:same-raw-session";

        for (session_id, purpose) in [(global_id, "global-auto"), (cn_id, "cn-auto")] {
            record_auto_session_metadata_core(
                &workspaces,
                &storage_path,
                "ws-1".to_string(),
                session_id.to_string(),
                AutoSessionMetadata {
                    session_purpose: purpose.to_string(),
                    visibility: AutoSessionVisibility::SystemAuto,
                    owner_feature: "qoder-test".to_string(),
                    auto_archive: Some(false),
                    created_by: AutoSessionCreatedBy::System,
                },
            )
            .await
            .expect("record profile-qualified Qoder metadata");
        }

        let metadata = read_catalog_metadata(&storage_path, "ws-1").expect("read metadata");
        assert_eq!(
            metadata
                .auto_session_by_session_id
                .get("qoder:ws-1:__qoder_global__:same-raw-session")
                .map(|metadata| metadata.session_purpose.as_str()),
            Some("global-auto")
        );
        assert_eq!(
            metadata
                .auto_session_by_session_id
                .get("qoder:ws-1:__qoder_cn__:same-raw-session")
                .map(|metadata| metadata.session_purpose.as_str()),
            Some("cn-auto")
        );
        assert!(!metadata
            .auto_session_by_session_id
            .contains_key("qoder:ws-1:same-raw-session"));

        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn legacy_qoder_metadata_keys_follow_their_explicit_cn_binding() {
        let base = std::env::temp_dir().join(format!("qoder-legacy-metadata-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("create temp dir");
        let storage_path = base.join("workspaces.json");
        std::fs::write(&storage_path, "[]").expect("seed storage path");
        let legacy_stable_key = "qoder:ws-1:same-raw-session";
        let auto_session = AutoSessionMetadata {
            session_purpose: "legacy-cn-auto".to_string(),
            visibility: AutoSessionVisibility::Hidden,
            owner_feature: "qoder-test".to_string(),
            auto_archive: Some(false),
            created_by: AutoSessionCreatedBy::System,
        };

        with_catalog_metadata_mutation(&storage_path, "ws-1", |metadata| {
            metadata.engine_provider_binding_by_session_key.insert(
                legacy_stable_key.to_string(),
                EngineProviderBinding {
                    provider_profile_id: "__qoder_cn__".to_string(),
                    provider_profile_source: "managed".to_string(),
                    provider_profile_name: "Qoder CN".to_string(),
                    provider_availability: "available".to_string(),
                },
            );
            metadata
                .auto_session_by_session_id
                .insert(legacy_stable_key.to_string(), auto_session.clone());
            metadata
                .auto_session_by_session_id
                .insert("qoder:same-raw-session".to_string(), auto_session.clone());
            Ok(())
        })
        .expect("seed legacy Qoder metadata");

        let metadata = read_catalog_metadata(&storage_path, "ws-1").expect("read migrated metadata");
        let canonical_stable_key = "qoder:ws-1:__qoder_cn__:same-raw-session";
        assert!(metadata
            .engine_provider_binding_by_session_key
            .contains_key(canonical_stable_key));
        assert!(metadata
            .auto_session_by_session_id
            .contains_key(canonical_stable_key));
        assert!(metadata
            .auto_session_by_session_id
            .contains_key("qoder:__qoder_cn__:same-raw-session"));
        assert!(!metadata
            .auto_session_by_session_id
            .contains_key(legacy_stable_key));
        assert!(!metadata
            .auto_session_by_session_id
            .contains_key("qoder:same-raw-session"));
        assert_eq!(
            auto_session_metadata_for_session(
                &metadata,
                "ws-1",
                "qoder:__qoder_cn__:same-raw-session",
                "qoder",
            )
            .map(|metadata| metadata.session_purpose.as_str()),
            Some("legacy-cn-auto")
        );

        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn legacy_qoder_metadata_with_unknown_owner_stays_fail_closed() {
        let legacy_stable_key = "qoder:ws-1:unknown-owner-session";
        let mut metadata = WorkspaceSessionCatalogMetadata {
            engine_provider_binding_by_session_key: HashMap::from([(
                legacy_stable_key.to_string(),
                EngineProviderBinding {
                    provider_profile_id: "provider-qoder".to_string(),
                    provider_profile_source: "managed".to_string(),
                    provider_profile_name: "Unknown Qoder".to_string(),
                    provider_availability: "available".to_string(),
                },
            )]),
            auto_session_by_session_id: HashMap::from([(
                legacy_stable_key.to_string(),
                AutoSessionMetadata {
                    session_purpose: "unknown-owner-auto".to_string(),
                    visibility: AutoSessionVisibility::Hidden,
                    owner_feature: "qoder-test".to_string(),
                    auto_archive: Some(false),
                    created_by: AutoSessionCreatedBy::System,
                },
            )]),
            ..Default::default()
        };

        normalize_legacy_qoder_catalog_metadata(&mut metadata, "ws-1");

        assert!(metadata
            .engine_provider_binding_by_session_key
            .contains_key(legacy_stable_key));
        assert!(metadata
            .auto_session_by_session_id
            .contains_key(legacy_stable_key));
        assert!(!metadata
            .auto_session_by_session_id
            .contains_key("qoder:ws-1:__qoder_global__:unknown-owner-session"));
    }

    #[test]
    fn provider_home_catalog_entry_projects_unavailable_provider_without_disk_fallback() {
        let mut entry = catalog_entry("codex-provider-session", "ws-1", Some("Workspace"), None);
        entry.provider_profile_id = Some("deleted-provider".to_string());
        entry.provider_profile_source = Some("managed".to_string());
        entry.provider_availability = Some("unknown".to_string());

        let finalized = finalize_existing_catalog_entry(entry, &HashMap::new());

        assert_eq!(
            finalized.provider_profile_id.as_deref(),
            Some("deleted-provider")
        );
        assert_eq!(finalized.provider_profile_source.as_deref(), Some("managed"));
        assert_eq!(
            finalized.provider_profile_name.as_deref(),
            Some("deleted-provider")
        );
        assert_eq!(
            finalized.provider_availability.as_deref(),
            Some("unavailable")
        );
        assert_eq!(finalized.source_label.as_deref(), Some("deleted-provider"));
    }

    #[test]
    fn mutation_target_resolves_provider_home_codex_row() {
        let workspace = workspace_entry("ws-1", "Workspace", "/tmp/ws-1", WorkspaceKind::Main, None);
        let workspaces = HashMap::from([(workspace.id.clone(), workspace)]);
        let mut entry = catalog_entry("provider-session", "ws-1", Some("Workspace"), None);
        entry.provider_profile_id = Some("provider-a".to_string());
        entry.provider_profile_source = Some("managed".to_string());
        entry.provider_profile_name = Some("Provider A".to_string());
        entry.provider_availability = Some("available".to_string());
        entry.physical_path = Some(
            "/tmp/app/codex-provider-homes/provider-a/sessions/2026/01/19/provider-session.jsonl"
                .to_string(),
        );

        let target = resolve_session_mutation_target(&[entry], &workspaces, "provider-session")
            .expect("provider-home row should resolve as mutation target");

        assert_eq!(target.owner_workspace_id, "ws-1");
        assert_eq!(target.native_session_id, "provider-session");
        assert_eq!(target.provider_profile_id.as_deref(), Some("provider-a"));
        assert!(target.exists_on_disk);
        assert_eq!(
            target.delete_mode.as_deref(),
            Some(SESSION_DELETE_MODE_PHYSICAL)
        );
    }
    #[tokio::test]
    async fn provider_home_only_codex_session_restores_from_catalog_without_runtime() {
        let base = std::env::temp_dir().join(format!("provider-home-catalog-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("create temp dir");
        let storage_path = base.join("workspaces.json");
        std::fs::write(&storage_path, "[]").expect("seed storage path");

        let workspace_path = base.join("workspace");
        std::fs::create_dir_all(&workspace_path).expect("create workspace path");
        let provider_home = base.join("codex-provider-homes").join("provider-a");
        write_codex_session_fixture(
            &provider_home,
            "provider-home-only",
            &workspace_path.to_string_lossy(),
        );

        let mut workspace = workspace_entry(
            "ws-1",
            "Workspace",
            &workspace_path.to_string_lossy(),
            WorkspaceKind::Main,
            None,
        );
        workspace.settings.codex_home = Some(provider_home.to_string_lossy().to_string());
        let workspaces = Mutex::new(HashMap::from([(workspace.id.clone(), workspace)]));
        let sessions = Mutex::new(HashMap::new());
        let engine_manager = engine::EngineManager::new();

        let page = list_workspace_sessions_core(
            &workspaces,
            &sessions,
            &engine_manager,
            &storage_path,
            "ws-1".to_string(),
            Some(WorkspaceSessionCatalogQuery {
                engine: Some("codex".to_string()),
                status: Some("all".to_string()),
                ..Default::default()
            }),
            None,
            Some(20),
        )
        .await
        .expect("list provider-home catalog sessions");

        let entry = page
            .data
            .iter()
            .find(|entry| entry.session_id == "provider-home-only")
            .expect("provider-home session should be restored from catalog");
        assert_eq!(entry.provider_profile_id.as_deref(), Some("provider-a"));
        assert_eq!(entry.provider_profile_source.as_deref(), Some("managed"));
        assert_eq!(entry.provider_profile_name.as_deref(), Some("provider-a"));
        assert_eq!(entry.provider_availability.as_deref(), Some("unavailable"));
        assert!(entry.exists_on_disk);
        assert!(page.source_statuses.iter().any(|status| {
            status.engine == "codex" && status.source_kind.as_deref() == Some("disk")
        }));
        assert!(page.source_statuses.iter().any(|status| {
            status.engine == "codex" && status.source_kind.as_deref() == Some("provider-home")
        }));

        std::fs::remove_dir_all(base).ok();
    }
    #[tokio::test]
    async fn provider_home_archive_folder_and_delete_target_only_session_file() {
        let base = std::env::temp_dir().join(format!("provider-home-mutate-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("create temp dir");
        let storage_path = base.join("workspaces.json");
        std::fs::write(&storage_path, "[]").expect("seed storage path");

        let workspace_path = base.join("workspace");
        std::fs::create_dir_all(&workspace_path).expect("create workspace path");
        let provider_home = base.join("codex-provider-homes").join("provider-a");
        let target_path = write_codex_session_fixture(
            &provider_home,
            "provider-delete-target",
            &workspace_path.to_string_lossy(),
        );
        let sibling_path = write_codex_session_fixture(
            &provider_home,
            "provider-keep-sibling",
            &workspace_path.to_string_lossy(),
        );

        let mut workspace = workspace_entry(
            "ws-1",
            "Workspace",
            &workspace_path.to_string_lossy(),
            WorkspaceKind::Main,
            None,
        );
        workspace.settings.codex_home = Some(provider_home.to_string_lossy().to_string());
        let workspaces = Mutex::new(HashMap::from([(workspace.id.clone(), workspace)]));
        let sessions = Mutex::new(HashMap::new());
        let engine_manager = engine::EngineManager::new();
        let requested_session_id = "provider-delete-target".to_string();
        let stable_key = "codex:ws-1:provider-delete-target".to_string();

        let folder = create_workspace_session_folder_core(
            &workspaces,
            &storage_path,
            "ws-1".to_string(),
            "Provider folder".to_string(),
            None,
        )
        .await
        .expect("create provider folder")
        .folder;
        let folder_response = assign_workspace_session_folder_core(
            &workspaces,
            &engine_manager,
            &storage_path,
            "ws-1".to_string(),
            requested_session_id.clone(),
            Some(folder.id.clone()),
        )
        .await
        .expect("assign provider-home folder");
        assert_eq!(folder_response.folder_id.as_deref(), Some(folder.id.as_str()));

        let archive_response = archive_workspace_sessions_core(
            &workspaces,
            &sessions,
            &engine_manager,
            &storage_path,
            "ws-1".to_string(),
            vec![requested_session_id.clone()],
        )
        .await
        .expect("archive provider-home session");
        assert!(archive_response.results[0].ok);

        let metadata = read_catalog_metadata(&storage_path, "ws-1").expect("read metadata");
        assert_eq!(
            metadata.folder_id_by_session_id.get(&stable_key),
            Some(&folder.id)
        );
        assert!(metadata.archived_at_by_session_id.contains_key(&stable_key));

        let delete_response = delete_workspace_sessions_core(
            &workspaces,
            &sessions,
            &engine_manager,
            &storage_path,
            "ws-1".to_string(),
            vec![requested_session_id],
        )
        .await
        .expect("delete provider-home session");
        assert!(delete_response.results[0].ok);
        assert_eq!(delete_response.results[0].deleted_from_disk, Some(true));
        assert!(!target_path.exists());
        assert!(sibling_path.exists());
        assert!(provider_home.exists());

        let metadata = read_catalog_metadata(&storage_path, "ws-1").expect("read cleaned metadata");
        assert!(!metadata.folder_id_by_session_id.contains_key(&stable_key));
        assert!(!metadata.archived_at_by_session_id.contains_key(&stable_key));

        std::fs::remove_dir_all(base).ok();
    }

    #[tokio::test]
    async fn provider_home_mutation_failure_reports_provider_aware_diagnostic() {
        let base =
            std::env::temp_dir().join(format!("provider-home-unresolved-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("create temp dir");
        let storage_path = base.join("workspaces.json");
        std::fs::write(&storage_path, "[]").expect("seed storage path");

        let workspace_path = base.join("workspace");
        std::fs::create_dir_all(&workspace_path).expect("create workspace path");
        let mut workspace = workspace_entry(
            "ws-1",
            "Workspace",
            &workspace_path.to_string_lossy(),
            WorkspaceKind::Main,
            None,
        );
        workspace.settings.codex_home = Some(
            base.join("codex-provider-homes")
                .join("provider-a")
                .to_string_lossy()
                .to_string(),
        );
        let workspaces = Mutex::new(HashMap::from([(workspace.id.clone(), workspace)]));
        let sessions = Mutex::new(HashMap::new());
        let engine_manager = engine::EngineManager::new();

        let response = delete_workspace_sessions_core(
            &workspaces,
            &sessions,
            &engine_manager,
            &storage_path,
            "ws-1".to_string(),
            vec!["codex:missing-provider-session".to_string()],
        )
        .await
        .expect("unresolved provider-home delete should return batch result");

        assert!(!response.results[0].ok);
        assert_eq!(
            response.results[0].code.as_deref(),
            Some("OWNER_WORKSPACE_UNRESOLVED")
        );
        assert!(response.results[0]
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("provider-home source"));

        std::fs::remove_dir_all(base).ok();
    }
