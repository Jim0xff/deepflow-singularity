import { describe, expect, test } from "@jest/globals";

import {
  buildHandoffSessionId,
  isValidBindingId,
  parseHandoffFile,
  parseOwnerNotifyFile,
  resolveAgentIdForHandoffFile,
  sanitizeSessionIdComponent,
  selectBindingIdForProject,
} from "../dist/handoff-notify/core.js";

describe("handoff-notify core", () => {
  test("parseHandoffFile parses handoff task path", () => {
    const parsed = parseHandoffFile(
      "/tmp/deepflow-assets/docs/projects/demo123/02_handoff/backend_task.md",
      "/tmp/deepflow-assets/docs",
    );

    expect(parsed).toEqual({
      projectId: "demo123",
      relativePath: "02_handoff/backend_task.md",
      agentId: "backend-developer",
    });
  });

  test("parseHandoffFile parses nodejs handoff task path", () => {
    const parsed = parseHandoffFile(
      "/tmp/deepflow-assets/docs/projects/demo123/02_handoff/nodejs_task.md",
      "/tmp/deepflow-assets/docs",
    );

    expect(parsed).toEqual({
      projectId: "demo123",
      relativePath: "02_handoff/nodejs_task.md",
      agentId: "nodejs-developer",
    });
  });

  test("parseHandoffFile parses receipt path", () => {
    const parsed = parseHandoffFile(
      "/tmp/deepflow-assets/docs/projects/demo123/03_receipts/frontend_receipt.md",
      "/tmp/deepflow-assets/docs",
    );

    expect(parsed).toEqual({
      projectId: "demo123",
      relativePath: "03_receipts/frontend_receipt.md",
      agentId: "product-designer",
    });
  });

  test("parseHandoffFile rejects non-target path", () => {
    const parsed = parseHandoffFile(
      "/tmp/deepflow-assets/docs/projects/demo123/01_product/prd.md",
      "/tmp/deepflow-assets/docs",
    );

    expect(parsed).toBeNull();
  });

  test("parseOwnerNotifyFile parses project_status path", () => {
    const parsed = parseOwnerNotifyFile(
      "/tmp/deepflow-assets/docs/projects/demo123/00_meta/project_status.md",
      "/tmp/deepflow-assets/docs",
    );

    expect(parsed).toEqual({
      projectId: "demo123",
      relativePath: "00_meta/project_status.md",
      actionType: "status_updated",
    });
  });

  test("resolveAgentIdForHandoffFile maps correctly", () => {
    expect(resolveAgentIdForHandoffFile("frontend_task.md")).toBe("frontend-developer");
    expect(resolveAgentIdForHandoffFile("backend_task.md")).toBe("backend-developer");
    expect(resolveAgentIdForHandoffFile("nodejs_task.md")).toBe("nodejs-developer");
    expect(resolveAgentIdForHandoffFile("frontend_receipt.md")).toBe("product-designer");
    expect(resolveAgentIdForHandoffFile("nodejs_receipt.md")).toBe("product-designer");
    expect(resolveAgentIdForHandoffFile("unknown.md")).toBeNull();
  });

  test("sanitizeSessionIdComponent and buildHandoffSessionId normalize safely", () => {
    expect(sanitizeSessionIdComponent("demo:001 / qa")).toBe("demo-001-qa");
    expect(buildHandoffSessionId("demo:001", "frontend-developer")).toBe("handoff-demo-001-frontend-developer");
  });

  test("selectBindingIdForProject prefers tg and then lexicographic", () => {
    const bindings = {
      "http:conv-z": "demo123",
      "http:conv-a": "demo123",
      "tg:-10001": "demo123",
      "tg:10002": "other",
    };

    expect(selectBindingIdForProject(bindings, "demo123")).toBe("tg:-10001");
    expect(selectBindingIdForProject({ "http:conv-z": "demo123", "http:conv-a": "demo123" }, "demo123")).toBe(
      "http:conv-a",
    );
  });

  test("isValidBindingId validates expected formats", () => {
    expect(isValidBindingId("tg:12345")).toBe(true);
    expect(isValidBindingId("tg:-100123")).toBe(true);
    expect(isValidBindingId("http:conversation_01")).toBe(true);
    expect(isValidBindingId("tg:-abc")).toBe(false);
  });
});
