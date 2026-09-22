import { expect, test } from "bun:test";
import { describePermission } from "./permissions";

const cwd = "/private/tmp/wt/add-a-license";

test("a file write names the file relative to the run", () => {
  expect(describePermission({ name: "Write", input: { file_path: `${cwd}/LICENSE.txt`, content: "x" } }, cwd)).toEqual({
    title: "Write a file",
    detail: "LICENSE.txt",
  });
  expect(describePermission({ name: "Edit", input: { file_path: "/tmp/wt/add-a-license/src/a.ts" } }, cwd)).toEqual({
    title: "Edit a file",
    detail: "src/a.ts",
  });
});

test("a command shows the command", () => {
  expect(describePermission({ name: "Bash", input: { command: "git commit -m 'x'" } }, cwd)).toEqual({
    title: "Run a command",
    detail: "git commit -m 'x'",
  });
});

test("provider wording wins when it exists, and unknown tools keep their name", () => {
  expect(describePermission({ name: "Bash", title: "Allow push", description: "git push origin" }, cwd)).toEqual({
    title: "Allow push",
    detail: "git push origin",
  });
  expect(describePermission({ name: "mcp__linear__save_issue" }, null)).toEqual({
    title: "mcp__linear__save_issue",
    detail: null,
  });
});

test("paths outside the run stay absolute", () => {
  expect(describePermission({ name: "Read", input: { file_path: "/etc/hosts" } }, cwd).detail).toBe("/etc/hosts");
});

test("tool names never resolve to object prototype members", () => {
  expect(describePermission({ name: "constructor" }, null).title).toBe("constructor");
  expect(describePermission({ name: "toString" }, null).title).toBe("toString");
});
