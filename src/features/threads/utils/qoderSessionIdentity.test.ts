import { describe, expect, it } from "vitest";

import {
  QODER_CN_PROVIDER_PROFILE_ID,
  QODER_GLOBAL_PROVIDER_PROFILE_ID,
  QODER_LOCAL_PROVIDER_PROFILE_ID,
} from "../constants/codexProviderProfiles";
import {
  canonicalQoderThreadId,
  collectQoderSessionIdentityKeys,
  parseQoderSessionIdentity,
} from "./qoderSessionIdentity";

describe("qoderSessionIdentity", () => {
  it("keeps identical raw ids isolated by Global and CN", () => {
    const globalId = canonicalQoderThreadId(
      "same-raw-session",
      QODER_GLOBAL_PROVIDER_PROFILE_ID,
    );
    const cnId = canonicalQoderThreadId(
      "same-raw-session",
      QODER_CN_PROVIDER_PROFILE_ID,
    );

    expect(globalId).toBe("qoder:__qoder_global__:same-raw-session");
    expect(cnId).toBe("qoder:__qoder_cn__:same-raw-session");
    expect(globalId).not.toBe(cnId);
    expect(collectQoderSessionIdentityKeys(globalId!)).toEqual([globalId]);
    expect(collectQoderSessionIdentityKeys(cnId!)).toEqual([cnId]);
  });

  it("rejects a canonical id whose embedded distribution conflicts with its owner", () => {
    expect(
      parseQoderSessionIdentity(
        "qoder:__qoder_cn__:same-raw-session",
        QODER_GLOBAL_PROVIDER_PROFILE_ID,
      ),
    ).toBeNull();
  });

  it("lets a canonical id override the historical local sentinel", () => {
    expect(
      parseQoderSessionIdentity(
        "qoder:__qoder_cn__:same-raw-session",
        QODER_LOCAL_PROVIDER_PROFILE_ID,
      ),
    ).toMatchObject({ providerProfileId: QODER_CN_PROVIDER_PROFILE_ID });
    expect(
      parseQoderSessionIdentity(
        "qoder:__qoder_cn__:same-raw-session",
        "",
      ),
    ).toMatchObject({ providerProfileId: QODER_CN_PROVIDER_PROFILE_ID });
  });

  it("keeps historic raw ids as Global-compatible aliases only", () => {
    expect(
      collectQoderSessionIdentityKeys("qoder:legacy-session"),
    ).toEqual([
      "qoder:__qoder_global__:legacy-session",
      "qoder:legacy-session",
      "legacy-session",
    ]);
  });

  it("does not expand a raw id with an explicit CN owner into Global aliases", () => {
    expect(
      collectQoderSessionIdentityKeys(
        "qoder:legacy-cn-session",
        QODER_CN_PROVIDER_PROFILE_ID,
      ),
    ).toEqual(["qoder:__qoder_cn__:legacy-cn-session"]);
  });
});
