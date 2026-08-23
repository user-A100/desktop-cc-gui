// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runQoderDoctor } from "../../../services/tauri";
import type { CodexDoctorResult } from "../../../types";
import { QoderDoctorSection } from "./QoderDoctorSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock("../../../services/tauri", () => ({
  runQoderDoctor: vi.fn(),
}));

const mockRunQoderDoctor = vi.mocked(runQoderDoctor);

const healthyDoctorResult: CodexDoctorResult = {
  ok: true,
  codexBin: "/opt/qoderclicn",
  version: "1.0.0",
  appServerOk: true,
  details: null,
  path: null,
  nodeOk: true,
  nodeVersion: "v22.0.0",
  nodeDetails: null,
};

beforeEach(() => {
  mockRunQoderDoctor.mockResolvedValue(healthyDoctorResult);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("QoderDoctorSection", () => {
  it("runs the doctor only on click and passes the selected CN binding", async () => {
    render(
      <QoderDoctorSection
        qoderBin="/opt/qoderclicn"
        providerProfileId="__qoder_cn__"
        cliName="qoderclicn"
      />,
    );

    expect(mockRunQoderDoctor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "运行 Doctor" }));

    await waitFor(() =>
      expect(mockRunQoderDoctor).toHaveBeenCalledWith(
        "/opt/qoderclicn",
        "__qoder_cn__",
      ),
    );
    expect(
      await screen.findByText("qoderclicn、认证与 ACP handshake 正常。"),
    ).toBeTruthy();
  });

  it("shows a distribution-specific diagnostic failure instead of hiding it", async () => {
    mockRunQoderDoctor.mockRejectedValueOnce(
      new Error("CN doctor unavailable"),
    );
    render(
      <QoderDoctorSection
        providerProfileId="__qoder_cn__"
        cliName="qoderclicn"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "运行 Doctor" }));

    expect(await screen.findByText("CN doctor unavailable")).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "运行 Doctor",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
