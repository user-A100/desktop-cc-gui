import { describe, expect, it } from "vitest";

import { classifySharedProviderRetryError } from "./classifySharedProviderRetryError";

describe("classifySharedProviderRetryError", () => {
  it("retries pool 403, 429, timeout, overload, and 5xx", () => {
    expect(
      classifySharedProviderRetryError({
        message:
          "Failed to authenticate. API Error: 403 API Key is not assigned to any group and cannot be used.",
      }),
    ).toMatchObject({ disposition: "retryable", kind: "pool", reason: "号池" });
    expect(
      classifySharedProviderRetryError({
        message: "API Error: 429 Too Many Requests",
      }),
    ).toMatchObject({ disposition: "retryable", kind: "rate" });
    expect(
      classifySharedProviderRetryError({
        message: "请求在收到响应前已超时。可能是网络抖动或上游服务繁忙导致，请稍后重试。",
      }),
    ).toMatchObject({ disposition: "retryable", kind: "timeout" });
    expect(
      classifySharedProviderRetryError({
        message: "upstream overloaded, please retry later",
      }),
    ).toMatchObject({ disposition: "retryable", kind: "overload" });
    expect(
      classifySharedProviderRetryError({
        message: "502 bad gateway",
      }),
    ).toMatchObject({ disposition: "retryable", kind: "server" });
    expect(
      classifySharedProviderRetryError({
        message: "provider request failed: rate_limited",
      }),
    ).toMatchObject({ disposition: "retryable", kind: "rate" });
    expect(
      classifySharedProviderRetryError({
        message:
          "No initial response within 30s. Network, proxy, or upstream service load may be causing delay. Please retry.",
      }),
    ).toMatchObject({ disposition: "retryable", kind: "timeout" });
    expect(
      classifySharedProviderRetryError({
        message:
          '会话失败：unexpected status 401 Unauthorized: {"code":"INVALID_API_KEY","message":"Invalid API key"}',
      }),
    ).toMatchObject({ disposition: "retryable", kind: "pool", reason: "号池" });
    expect(
      classifySharedProviderRetryError({
        message: '会话失败：unexpected status 405: {"code":"405"}',
      }),
    ).toMatchObject({ disposition: "retryable", kind: "pool", reason: "号池" });
    expect(
      classifySharedProviderRetryError({
        message: '{"code":"424","message":"Failed Dependency"}',
      }),
    ).toMatchObject({ disposition: "retryable", kind: "pool", reason: "号池" });
    expect(
      classifySharedProviderRetryError({
        message: '{"code":429}',
      }),
    ).toMatchObject({ disposition: "retryable", kind: "rate" });
    expect(
      classifySharedProviderRetryError({
        message: '{"code":"502"}',
      }),
    ).toMatchObject({ disposition: "retryable", kind: "server" });
    expect(
      classifySharedProviderRetryError({
        message:
          "会话失败：Claude exited with status: exit code: 1. Diagnostics: input_format=stream-json, include_hook_events=true, permission_mode=full-access. No stdout/stderr diagnostics were observed.",
      }),
    ).toMatchObject({ disposition: "retryable", kind: "soft-cancel", reason: "暂时中断" });
    expect(
      classifySharedProviderRetryError({
        message: "Kimi exited with status: exit status: 1",
      }),
    ).toMatchObject({ disposition: "retryable", kind: "soft-cancel" });
  });

  it("does not treat tool permission, window capacity, or filename 5xx as retryable", () => {
    expect(
      classifySharedProviderRetryError({
        message: "Edit tool permission denied",
      }),
    ).toMatchObject({ disposition: "ignore", kind: "unknown" });
    expect(
      classifySharedProviderRetryError({
        message: "Waiting for CLI window capacity",
      }),
    ).toMatchObject({ disposition: "ignore", kind: "unknown" });
    expect(
      classifySharedProviderRetryError({
        message: "failed to read /tmp/job-503.log",
      }),
    ).toMatchObject({ disposition: "ignore", kind: "unknown" });
  });

  it("retries a bare Turn cancelled only when the user did not stop", () => {
    expect(
      classifySharedProviderRetryError({
        message: "Turn cancelled",
        wasLocalInterrupt: false,
      }),
    ).toMatchObject({ disposition: "retryable", kind: "soft-cancel" });
    expect(
      classifySharedProviderRetryError({
        message: "Turn cancelled: Session stopped.",
        wasLocalInterrupt: true,
      }),
    ).toMatchObject({ disposition: "abort", kind: "user-stop" });
    expect(
      classifySharedProviderRetryError({
        message:
          "Claude exited with status: exit code: 1. Diagnostics: input_format=stream-json, include_hook_events=true, permission_mode=full-access. No stdout/stderr diagnostics were observed.",
        wasLocalInterrupt: true,
      }),
    ).toMatchObject({ disposition: "abort", kind: "user-stop" });
  });

  it("does not auto-retry config, overflow, or recovery states", () => {
    expect(
      classifySharedProviderRetryError({
        message:
          "invalid_request_error: Item 'msg_1' of type 'message' was provided without its required reasoning item: 'rs_1'",
      }),
    ).toMatchObject({ disposition: "permanent", kind: "config" });
    expect(
      classifySharedProviderRetryError({
        message: "unknown model 'claude-opus-5'",
      }),
    ).toMatchObject({ disposition: "permanent", kind: "config" });
    expect(
      classifySharedProviderRetryError({
        message: "prompt too long",
      }),
    ).toMatchObject({ disposition: "permanent", kind: "overflow" });
    expect(
      classifySharedProviderRetryError({
        message: "API Key is not assigned to any group",
        sendState: "recovery-required",
      }),
    ).toMatchObject({ disposition: "ignore", kind: "recovery" });
  });

  it("fails closed on unrecognized errors", () => {
    expect(
      classifySharedProviderRetryError({
        message: "something completely unexpected exploded",
        outcome: "failed",
      }),
    ).toMatchObject({ disposition: "ignore", kind: "unknown" });
  });
});
