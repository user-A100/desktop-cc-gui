#[test]
fn engine_provider_binding_uses_explicit_engine_for_unprefixed_session_id() {
    let binding = EngineProviderBinding {
        provider_profile_id: "kimi-provider-a".to_string(),
        provider_profile_source: "managed".to_string(),
        provider_profile_name: "Kimi Provider A".to_string(),
        provider_availability: "available".to_string(),
    };
    let metadata = WorkspaceSessionCatalogMetadata {
        engine_provider_binding_by_session_key: HashMap::from([(
            "kimi:ws-1:native-session-1".to_string(),
            binding.clone(),
        )]),
        ..Default::default()
    };

    assert_eq!(
        engine_provider_binding_for_session(&metadata, "ws-1", "native-session-1", "kimi"),
        Some(binding)
    );
    assert!(
        engine_provider_binding_for_session(&metadata, "ws-1", "native-session-1", "codex")
            .is_none()
    );
}

#[test]
fn engine_provider_binding_projects_for_claude_and_kimi() {
    let metadata = WorkspaceSessionCatalogMetadata {
        engine_provider_binding_by_session_key: HashMap::from([
            (
                "claude:ws-1:claude-session-1".to_string(),
                EngineProviderBinding {
                    provider_profile_id: "claude-provider-a".to_string(),
                    provider_profile_source: "managed".to_string(),
                    provider_profile_name: "Claude Provider A".to_string(),
                    provider_availability: "available".to_string(),
                },
            ),
            (
                "kimi:ws-1:kimi-session-1".to_string(),
                EngineProviderBinding {
                    provider_profile_id: "kimi-provider-a".to_string(),
                    provider_profile_source: "managed".to_string(),
                    provider_profile_name: "Kimi Provider A".to_string(),
                    provider_availability: "available".to_string(),
                },
            ),
        ]),
        ..Default::default()
    };
    let metadata_by_workspace_id = HashMap::from([("ws-1".to_string(), metadata)]);
    let mut claude = catalog_entry("claude:claude-session-1", "ws-1", None, None);
    claude.engine = "claude".to_string();
    let mut kimi = catalog_entry("kimi:kimi-session-1", "ws-1", None, None);
    kimi.engine = "kimi".to_string();

    let claude = finalize_existing_catalog_entry(claude, &metadata_by_workspace_id);
    let kimi = finalize_existing_catalog_entry(kimi, &metadata_by_workspace_id);

    assert_eq!(
        claude.provider_profile_id.as_deref(),
        Some("claude-provider-a")
    );
    assert_eq!(
        kimi.provider_profile_name.as_deref(),
        Some("Kimi Provider A")
    );
}

#[tokio::test]
async fn record_engine_provider_binding_is_idempotent_and_restart_readable() {
    let base = std::env::temp_dir().join(format!("engine-provider-binding-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).expect("create temp dir");
    let storage_path = base.join("workspaces.json");
    std::fs::write(&storage_path, "[]").expect("seed storage path");
    let workspace = workspace_entry("ws-1", "Workspace", "/tmp/ws-1", WorkspaceKind::Main, None);
    let workspaces = Mutex::new(HashMap::from([(workspace.id.clone(), workspace)]));
    let binding = EngineProviderBinding {
        provider_profile_id: "provider-a".to_string(),
        provider_profile_source: "managed".to_string(),
        provider_profile_name: "Provider A".to_string(),
        provider_availability: "available".to_string(),
    };

    assert!(record_engine_provider_binding_core(
        &workspaces,
        &storage_path,
        "ws-1".to_string(),
        "native-session-1".to_string(),
        "kimi".to_string(),
        binding.clone(),
    )
    .await
    .expect("record binding"));
    assert!(!record_engine_provider_binding_core(
        &workspaces,
        &storage_path,
        "ws-1".to_string(),
        "native-session-1".to_string(),
        "kimi".to_string(),
        binding.clone(),
    )
    .await
    .expect("skip unchanged binding"));

    let reloaded = read_catalog_metadata(&storage_path, "ws-1").expect("reload metadata");
    assert_eq!(
        engine_provider_binding_for_session(&reloaded, "ws-1", "native-session-1", "kimi"),
        Some(binding)
    );
    std::fs::remove_dir_all(base).ok();
}

#[test]
fn canonical_identity_binding_is_restart_readable_without_second_send() {
    let base = std::env::temp_dir().join(format!("canonical-provider-binding-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).expect("create temp dir");
    let storage_path = base.join("workspaces.json");
    std::fs::write(&storage_path, "[]").expect("seed storage path");
    let binding = EngineProviderBinding {
        provider_profile_id: "provider-a".to_string(),
        provider_profile_source: "managed".to_string(),
        provider_profile_name: "Provider A".to_string(),
        provider_availability: "available".to_string(),
    };

    assert!(record_engine_provider_binding_at_path(
        &storage_path,
        "ws-1",
        "session-canonical-1",
        "kimi",
        &binding,
    )
    .expect("record canonical binding"));

    let reloaded = read_catalog_metadata(&storage_path, "ws-1").expect("reload metadata");
    assert_eq!(
        engine_provider_binding_for_session(&reloaded, "ws-1", "kimi:session-canonical-1", "kimi",),
        Some(binding)
    );
    std::fs::remove_dir_all(base).ok();
}

#[test]
fn effective_engine_provider_profile_prefers_request_then_catalog_then_default() {
    let base = std::env::temp_dir().join(format!("engine-provider-resolution-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).expect("create temp dir");
    let storage_path = base.join("workspaces.json");
    std::fs::write(&storage_path, "[]").expect("seed storage path");
    with_catalog_metadata_mutation(&storage_path, "ws-1", |metadata| {
        metadata.engine_provider_binding_by_session_key.insert(
            "claude:ws-1:session-1".to_string(),
            EngineProviderBinding {
                provider_profile_id: "persisted-provider".to_string(),
                provider_profile_source: "managed".to_string(),
                provider_profile_name: "Persisted Provider".to_string(),
                provider_availability: "available".to_string(),
            },
        );
        Ok(())
    })
    .expect("seed provider binding");

    assert_eq!(
        resolve_engine_provider_profile_id(
            &storage_path,
            "ws-1",
            Some("claude:session-1"),
            "claude",
            Some("request-provider"),
        )
        .expect("resolve request binding")
        .as_deref(),
        Some("request-provider")
    );
    assert_eq!(
        resolve_engine_provider_profile_id(
            &storage_path,
            "ws-1",
            Some("claude:session-1"),
            "claude",
            None,
        )
        .expect("resolve persisted binding")
        .as_deref(),
        Some("persisted-provider")
    );
    assert_eq!(
        resolve_engine_provider_profile_id(
            &storage_path,
            "ws-1",
            Some("claude:unknown"),
            "claude",
            None,
        )
        .expect("resolve default"),
        None
    );
    std::fs::remove_dir_all(base).ok();
}

#[test]
fn qoder_provider_resolution_uses_canonical_identity_and_legacy_binding() {
    let base = std::env::temp_dir().join(format!("qoder-provider-resolution-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).expect("create temp dir");
    let storage_path = base.join("workspaces.json");
    std::fs::write(&storage_path, "[]").expect("seed storage path");
    let legacy_cn_binding = EngineProviderBinding {
        provider_profile_id: "__qoder_cn__".to_string(),
        provider_profile_source: "managed".to_string(),
        provider_profile_name: "Qoder CN".to_string(),
        provider_availability: "available".to_string(),
    };
    let legacy_metadata = WorkspaceSessionCatalogMetadata {
        engine_provider_binding_by_session_key: HashMap::from([(
            "qoder:ws-1:legacy-cn-session".to_string(),
            legacy_cn_binding.clone(),
        )]),
        ..Default::default()
    };
    assert_eq!(
        engine_provider_binding_for_session(
            &legacy_metadata,
            "ws-1",
            "qoder:__qoder_cn__:legacy-cn-session",
            "qoder",
        ),
        Some(legacy_cn_binding.clone())
    );
    assert!(engine_provider_binding_for_session(
        &legacy_metadata,
        "ws-1",
        "qoder:__qoder_global__:legacy-cn-session",
        "qoder",
    )
    .is_none());
    with_catalog_metadata_mutation(&storage_path, "ws-1", |metadata| {
        metadata.engine_provider_binding_by_session_key.insert(
            "qoder:ws-1:legacy-cn-session".to_string(),
            legacy_cn_binding.clone(),
        );
        Ok(())
    })
    .expect("seed legacy qoder binding");

    let metadata = read_catalog_metadata(&storage_path, "ws-1").expect("read migrated metadata");
    assert_eq!(
        engine_provider_binding_for_session(
            &metadata,
            "ws-1",
            "qoder:__qoder_cn__:legacy-cn-session",
            "qoder",
        ),
        Some(legacy_cn_binding.clone())
    );

    assert_eq!(
        resolve_engine_provider_profile_id(
            &storage_path,
            "ws-1",
            Some("qoder:__qoder_cn__:same-raw-session"),
            "qoder",
            None,
        )
        .expect("resolve canonical CN")
        .as_deref(),
        Some("__qoder_cn__")
    );
    assert_eq!(
        resolve_engine_provider_profile_id(
            &storage_path,
            "ws-1",
            Some("qoder:legacy-cn-session"),
            "qoder",
            None,
        )
        .expect("resolve legacy CN binding")
        .as_deref(),
        Some("__qoder_cn__")
    );
    assert_eq!(
        resolve_engine_provider_profile_id(
            &storage_path,
            "ws-1",
            Some("qoder:legacy-cn-session"),
            "qoder",
            Some("__local_qoder__"),
        )
        .expect("legacy local sentinel must consult persisted CN binding")
        .as_deref(),
        Some("__qoder_cn__")
    );
    assert_eq!(
        resolve_engine_provider_profile_id(
            &storage_path,
            "ws-1",
            Some("qoder:legacy-cn-session"),
            "qoder",
            Some("__qoder_global__"),
        )
        .expect("explicit Global owner overrides legacy binding")
        .as_deref(),
        Some("__qoder_global__")
    );

    let global_binding = EngineProviderBinding {
        provider_profile_id: "__qoder_global__".to_string(),
        provider_profile_source: "managed".to_string(),
        provider_profile_name: "Qoder Global".to_string(),
        provider_availability: "available".to_string(),
    };
    let dual_distribution_metadata = WorkspaceSessionCatalogMetadata {
        engine_provider_binding_by_session_key: HashMap::from([
            (
                "qoder:ws-1:__qoder_global__:same-raw-session".to_string(),
                global_binding.clone(),
            ),
            (
                "qoder:ws-1:__qoder_cn__:same-raw-session".to_string(),
                legacy_cn_binding.clone(),
            ),
        ]),
        ..Default::default()
    };
    assert_eq!(
        engine_provider_binding_for_session(
            &dual_distribution_metadata,
            "ws-1",
            "qoder:same-raw-session",
            "qoder",
        ),
        Some(global_binding)
    );
    assert_eq!(
        engine_provider_binding_for_session(
            &dual_distribution_metadata,
            "ws-1",
            "qoder:__qoder_cn__:same-raw-session",
            "qoder",
        ),
        Some(legacy_cn_binding.clone())
    );
    assert!(
        resolve_engine_provider_profile_id(
            &storage_path,
            "ws-1",
            Some("qoder:__qoder_cn__:same-raw-session"),
            "qoder",
            Some("__qoder_global__"),
        )
        .is_err()
    );
    std::fs::remove_dir_all(base).ok();
}

#[test]
fn legacy_qoder_provider_resolution_rejects_unknown_binding() {
    let base = std::env::temp_dir().join(format!("qoder-unknown-provider-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).expect("create temp dir");
    let storage_path = base.join("workspaces.json");
    std::fs::write(&storage_path, "[]").expect("seed storage path");
    with_catalog_metadata_mutation(&storage_path, "ws-1", |metadata| {
        metadata.engine_provider_binding_by_session_key.insert(
            "qoder:ws-1:unknown-owner-session".to_string(),
            EngineProviderBinding {
                provider_profile_id: "provider-qoder".to_string(),
                provider_profile_source: "managed".to_string(),
                provider_profile_name: "Unknown Qoder".to_string(),
                provider_availability: "available".to_string(),
            },
        );
        Ok(())
    })
    .expect("seed unknown Qoder binding");

    let error = resolve_engine_provider_profile_id(
        &storage_path,
        "ws-1",
        Some("qoder:unknown-owner-session"),
        "qoder",
        None,
    )
    .expect_err("unknown Qoder binding must not fall back to Global");
    assert!(error.contains("refusing Global fallback"));

    std::fs::remove_dir_all(base).ok();
}

#[test]
fn deleting_session_metadata_removes_provider_bindings() {
    let stable_key = "claude:ws-1:session-1".to_string();
    let binding = EngineProviderBinding {
        provider_profile_id: "provider-a".to_string(),
        provider_profile_source: "managed".to_string(),
        provider_profile_name: "Provider A".to_string(),
        provider_availability: "available".to_string(),
    };
    let mut metadata = WorkspaceSessionCatalogMetadata {
        engine_provider_binding_by_session_key: HashMap::from([(
            stable_key.clone(),
            binding.clone(),
        )]),
        codex_provider_binding_by_session_id: HashMap::from([(
            "claude:session-1".to_string(),
            binding,
        )]),
        ..Default::default()
    };

    remove_catalog_metadata_for_session(&mut metadata, "ws-1", "claude:session-1");

    assert!(!metadata
        .engine_provider_binding_by_session_key
        .contains_key(&stable_key));
    assert!(!metadata
        .codex_provider_binding_by_session_id
        .contains_key("claude:session-1"));
}

#[test]
fn session_index_overlay_fills_provider_from_binding_ledger() {
    let base = std::env::temp_dir().join(format!("index-overlay-binding-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).expect("create temp dir");
    let storage_path = base.join("workspaces.json");
    std::fs::write(&storage_path, "[]").expect("seed storage path");
    let binding = EngineProviderBinding {
        provider_profile_id: "provider-a".to_string(),
        provider_profile_source: "managed".to_string(),
        provider_profile_name: "Provider A".to_string(),
        provider_availability: "available".to_string(),
    };
    assert!(record_engine_provider_binding_at_path(
        &storage_path,
        "ws-1",
        "grok-session-1",
        "grok",
        &binding,
    )
    .expect("record binding"));

    let mut rows = vec![crate::session_index::store::SessionIndexRow {
        engine: "grok".to_string(),
        session_id: "grok-session-1".to_string(),
        title: "你好".to_string(),
        native_title: None,
        updated_at: 1,
        created_at: None,
        cwd: None,
        workspace_path: None,
        physical_path: None,
        parent_session_id: None,
        size_bytes: None,
        provider_profile_id: None,
        provider_profile_name: None,
    }];
    overlay_session_index_provider_bindings(&storage_path, "ws-1", &mut rows);

    assert_eq!(rows[0].provider_profile_id.as_deref(), Some("provider-a"));
    assert_eq!(rows[0].provider_profile_name.as_deref(), Some("Provider A"));
    std::fs::remove_dir_all(base).ok();
}

#[test]
fn session_index_overlay_codex_falls_back_to_provider_home_path() {
    let base = std::env::temp_dir().join(format!("index-overlay-codex-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).expect("create temp dir");
    let storage_path = base.join("workspaces.json");
    std::fs::write(&storage_path, "[]").expect("seed storage path");

    let mut rows = vec![crate::session_index::store::SessionIndexRow {
        engine: "codex".to_string(),
        session_id: "codex-session-1".to_string(),
        title: "你好".to_string(),
        native_title: None,
        updated_at: 1,
        created_at: None,
        cwd: None,
        workspace_path: None,
        physical_path: Some(
            "/Users/x/.ccgui/codex-provider-homes/profile-xyz/sessions/2026/08/19/rollout-1.jsonl"
                .to_string(),
        ),
        parent_session_id: None,
        size_bytes: None,
        provider_profile_id: None,
        provider_profile_name: None,
    }];
    // 账本完全缺失也要能从路径推断 id（name 依赖本机 config，不断言具体值）。
    overlay_session_index_provider_bindings(&storage_path, "ws-1", &mut rows);

    assert_eq!(
        rows[0].provider_profile_id.as_deref(),
        Some("profile-xyz")
    );
    assert!(rows[0].provider_profile_name.is_some());
    std::fs::remove_dir_all(base).ok();
}

#[test]
fn session_index_overlay_keeps_existing_provider_and_survives_missing_metadata() {
    let base = std::env::temp_dir().join(format!("index-overlay-keep-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&base).expect("create temp dir");
    let storage_path = base.join("workspaces.json");
    // 连 workspaces.json 都不写：metadata 读取失败必须静默降级。
    let mut rows = vec![crate::session_index::store::SessionIndexRow {
        engine: "claude".to_string(),
        session_id: "claude-session-1".to_string(),
        title: "你好".to_string(),
        native_title: None,
        updated_at: 1,
        created_at: None,
        cwd: None,
        workspace_path: None,
        physical_path: None,
        parent_session_id: None,
        size_bytes: None,
        provider_profile_id: Some("provider-keep".to_string()),
        provider_profile_name: Some("Keep Me".to_string()),
    }];
    overlay_session_index_provider_bindings(&storage_path, "ws-1", &mut rows);

    assert_eq!(
        rows[0].provider_profile_id.as_deref(),
        Some("provider-keep")
    );
    assert_eq!(rows[0].provider_profile_name.as_deref(), Some("Keep Me"));
    std::fs::remove_dir_all(base).ok();
}
