import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskHome } from "../shared/fleet";
import { MEDIA_MAX_BYTES, sourceText, sourceUrl } from "../shared/rich-ask";
import { decisionsOf } from "./control-asks";
import { attachmentAsk, attachmentOf, lockedHtml, mediaOf, readAttachment, readInside, richOf } from "./rich-ask";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maestro-rich-")));
  roots.push(root);
  return root;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A ledger with v2 on the ask and on an option, plus entries Maestro must drop. */
const RICH = `arc: rich
opened: 2026-10-17T00:00Z
tz: America/Bogota
lanes: [a]
asks:
  - id: R1
    headline: "Which card design ships?"
    stakes: "The card waits."
    why_you: "Taste is yours."
    summary: "Two designs for the phone card. A is denser; B shows a bigger picture."
    tradeoffs:
      - { option: dense, cost: "none", risk: "cramped" }
      - { option: airy, time: "a day" }
      - { option: ghost, cost: "x" }
      - { label: "Either", reversibility: "a revert" }
      - { option: dense, label: "both", cost: "x" }
      - { option: airy }
    sources:
      - { kind: spec, ref: "docs/specs/card.html#variants", label: "Card spec" }
      - { kind: ticket, ref: BRO-3167 }
      - { kind: pr, ref: "broomva/maestro-paseo#80" }
      - { kind: url, ref: "http://insecure.example.com" }
      - { kind: file, ref: "../../etc/passwd" }
      - { kind: wiki, ref: "x" }
    media:
      - { kind: video, url: "https://example.com/cut.mp4", caption: "The cut" }
      - { kind: image, path: "/etc/hosts" }
    details: "## Why\\n\\nLonger."
    options:
      - id: dense
        label: "Dense"
        consequence: "Ships A."
        reversible: true
        recommended: true
        media:
          - { kind: image, path: "docs/a.png", caption: "Variant A" }
          - { kind: image, path: "docs/a.mp4" }
      - id: airy
        label: "Airy"
        consequence: "Ships B."
        reversible: true
        media:
          - { kind: image, path: "docs/b.png", caption: "Variant B" }
    class: decision
    gates: [a]
    blocking: false
    default: "dense"
  - id: R2
    headline: "Plain yes or no?"
    stakes: "Nothing."
    why_you: "Yours."
    options:
      - { id: yes, label: "Yes", consequence: "Yes.", reversible: true, recommended: true }
      - { id: no, label: "No", consequence: "No.", reversible: true }
`;

describe("reading decision layer v2 from a ledger", () => {
  const [rich, plain] = decisionsOf(RICH, "rich.yaml");

  test("an ask with v2 carries what it says, minus what Maestro could not show", () => {
    expect(rich?.rich?.summary).toBe("Two designs for the phone card. A is denser; B shows a bigger picture.");
    expect(rich?.rich?.tradeoffs).toEqual([
      { option: "dense", label: null, cost: "none", risk: "cramped", time: null, reversibility: null },
      { option: "airy", label: null, cost: null, risk: null, time: "a day", reversibility: null },
      { option: null, label: "Either", cost: null, risk: null, time: null, reversibility: "a revert" },
    ]);
    expect(rich?.rich?.sources.map((s) => `${s.kind}:${s.ref}`)).toEqual([
      "spec:docs/specs/card.html#variants",
      "ticket:BRO-3167",
      "pr:broomva/maestro-paseo#80",
    ]);
    expect(rich?.rich?.media).toEqual([
      { kind: "video", path: null, url: "https://example.com/cut.mp4", caption: "The cut" },
    ]);
    expect(rich?.rich?.details).toBe("## Why\n\nLonger.");
  });

  test("an option's media rides on the option, a wrong extension dropped", () => {
    expect(rich?.options[0]?.media).toEqual([{ kind: "image", path: "docs/a.png", url: null, caption: "Variant A" }]);
    expect(rich?.options[1]?.media?.[0]?.caption).toBe("Variant B");
  });

  test("an ask without v2 reads exactly as before: rich null, options with no media key", () => {
    expect(plain?.rich).toBeNull();
    expect(plain?.options.every((option) => !("media" in option))).toBe(true);
  });

  test("a hash still pins the entry: v2 fields are part of what you read", () => {
    const changed = decisionsOf(RICH.replace("A is denser", "A is tighter"), "rich.yaml")[0];
    expect(changed?.hash).not.toBe(rich?.hash);
  });
});

describe("mediaOf and richOf, alone", () => {
  test("a media entry needs exactly one of path and url", () => {
    expect(mediaOf([{ kind: "image" }, { kind: "image", path: "a.png", url: "https://x/a.png" }], 4)).toEqual([]);
  });
  test("media are capped", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: "image", url: `https://x/${i}.png` }));
    expect(mediaOf(many, 4)).toHaveLength(4);
  });
  test("an ask whose v2 entries are all unusable is null, not an empty shell", () => {
    expect(richOf({ sources: [{ kind: "url", ref: "javascript:alert(1)" }] }, new Set())).toBeNull();
  });
});

describe("the links a source opens", () => {
  test("ticket, PR and https URL have web addresses; files and sessions do not", () => {
    expect(sourceUrl({ kind: "ticket", ref: "BRO-3167" })).toBe("https://linear.app/broomva/issue/BRO-3167");
    expect(sourceUrl({ kind: "pr", ref: "broomva/workspace#1018" })).toBe(
      "https://github.com/broomva/workspace/pull/1018",
    );
    expect(sourceUrl({ kind: "url", ref: "https://example.com/a" })).toBe("https://example.com/a");
    expect(sourceUrl({ kind: "spec", ref: "docs/specs/a.html" })).toBeNull();
    expect(sourceUrl({ kind: "session", ref: "64c5a6b0" })).toBeNull();
  });
  test("a chip names a file by its name and keeps the anchor", () => {
    expect(sourceText({ kind: "spec", ref: "docs/specs/a.html#kinds", label: null })).toBe("a.html#kinds");
    expect(sourceText({ kind: "spec", ref: "docs/specs/a.html", label: "The spec" })).toBe("The spec");
  });
});

describe("reading a file an ask names", () => {
  const home = (path: string): AskHome => ({ kind: "checkout", path, branch: "b" });

  test("a checkout's image comes back as a data URL", async () => {
    const repo = await scratch();
    await mkdir(join(repo, "docs"));
    await writeFile(join(repo, "docs", "a.png"), PNG);
    const [ask] = decisionsOf(RICH, "rich.yaml", home(repo));
    if (!ask) throw new Error("no ask");
    const got = await readAttachment(ask, { list: "media", option: "dense", index: 0 });
    expect(got.mime).toBe("image/png");
    expect(got.dataUrl).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(got.webUrl).toBeNull();
  });

  test("a fleet root's paths start at the folder that holds .control/asks", async () => {
    const base = await scratch();
    const root = join(base, ".control", "asks");
    await mkdir(root, { recursive: true });
    await mkdir(join(base, "docs"));
    await writeFile(join(base, "docs", "b.png"), PNG);
    const [ask] = decisionsOf(RICH, "rich.yaml", { kind: "root", path: root, branch: null });
    if (!ask) throw new Error("no ask");
    const got = await readAttachment(ask, { list: "media", option: "airy", index: 0 });
    expect(got.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("a link that leads out of the home is refused", async () => {
    const outside = await scratch();
    await writeFile(join(outside, "secret.png"), PNG);
    const repo = await scratch();
    await mkdir(join(repo, "docs"));
    await symlink(join(outside, "secret.png"), join(repo, "docs", "a.png"));
    const [ask] = decisionsOf(RICH, "rich.yaml", home(repo));
    if (!ask) throw new Error("no ask");
    await expect(readAttachment(ask, { list: "media", option: "dense", index: 0 })).rejects.toThrow(/leads outside/);
  });

  test("a path that climbs out is refused before any read", async () => {
    const repo = await scratch();
    await expect(readInside(repo, "../x.png", 10)).rejects.toThrow(/not a path inside/);
  });

  test("a file over its kind's cap is refused", async () => {
    const repo = await scratch();
    await mkdir(join(repo, "docs"));
    await writeFile(join(repo, "docs", "a.png"), Buffer.alloc(MEDIA_MAX_BYTES.image + 1));
    const [ask] = decisionsOf(RICH, "rich.yaml", home(repo));
    if (!ask) throw new Error("no ask");
    await expect(readAttachment(ask, { list: "media", option: "dense", index: 0 })).rejects.toThrow(/over the/);
  });

  test("only what the ask names is read: a URL, a link source, a missing index", () => {
    const [ask] = decisionsOf(RICH, "rich.yaml");
    if (!ask) throw new Error("no ask");
    expect(() => attachmentOf(ask, { list: "media", option: null, index: 0 })).toThrow(/web address/);
    expect(() => attachmentOf(ask, { list: "sources", option: null, index: 1 })).toThrow(/a link, not a file/);
    expect(() => attachmentOf(ask, { list: "media", option: "dense", index: 5 })).toThrow(/no such picture/);
    expect(() => attachmentOf(ask, { list: "sources", option: "dense", index: 0 })).toThrow(/not to an option/);
    expect(attachmentOf(ask, { list: "sources", option: null, index: 0 })).toEqual({
      path: "docs/specs/card.html",
      kind: "doc",
    });
  });

  test("on origin/main the file is the blob at that ref, never the working tree", async () => {
    const repo = await scratch();
    const run = (...args: string[]) => {
      const done = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      if (done.status !== 0) throw new Error(done.stderr);
    };
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    await mkdir(join(repo, "docs", "specs"), { recursive: true });
    await writeFile(join(repo, "docs", "specs", "card.html"), "<html><head></head><body><img src=x></body></html>");
    run("add", ".");
    run("commit", "-qm", "spec");
    run("update-ref", "refs/remotes/origin/main", "HEAD");
    // The working tree now says something else: main's blob is what is read.
    await writeFile(join(repo, "docs", "specs", "card.html"), "<html>changed</html>");
    const [ask] = decisionsOf(RICH, "rich.yaml", { kind: "main", path: repo, branch: null });
    if (!ask) throw new Error("no ask");
    const got = await readAttachment(ask, { list: "sources", option: null, index: 0 });
    expect(got.mime).toBe("text/html");
    expect(got.text).toContain("<img src=x>");
    expect(got.text).toContain("Content-Security-Policy");
    expect(got.text).not.toContain("changed");
  });
});

test("an HTML file is locked before it is drawn: the policy comes first, whatever the file holds", () => {
  for (const html of [
    "<html><head><title>x</title></head></html>",
    "<p>no head</p>",
    // P20 round 1: a <header> matched a /<head/ pattern, and an <img> before <head> sat outside the policy.
    "<header>h</header><head></head>",
    '<img src="https://evil.example/beacon"><html><head></head></html>',
  ]) {
    const locked = lockedHtml(html);
    expect(locked.startsWith('<meta http-equiv="Content-Security-Policy" content="default-src \'none\';')).toBe(true);
    expect(locked.endsWith(html)).toBe(true);
  }
});

test("a page's own http-equiv metas are taken out, a refresh in any spelling among them (P20 round 2)", () => {
  for (const meta of [
    '<meta http-equiv="refresh" content="0;url=https://evil.example/pixel">',
    "<META HTTP-EQUIV=Refresh CONTENT='0;url=https://evil.example/'>",
    '<meta content="0;url=https://evil.example/?a>b" http-equiv="refr&#101;sh">',
    "<meta/http-equiv=refresh content=0;url=https://evil.example/>",
  ]) {
    const locked = lockedHtml(`<html><head>${meta}</head><body>ok</body></html>`);
    expect(locked).not.toContain("evil.example");
    expect(locked).toContain("<body>ok</body>");
  }
  // A charset meta stays: only http-equiv ones go.
  expect(lockedHtml('<meta charset="utf-8"><p>x</p>')).toContain('<meta charset="utf-8">');
});

test("details are cut by code points, as Python counts them (P20 round 2)", () => {
  const details = "😀".repeat(9000);
  const read = richOf({ details }, new Set())?.details ?? "";
  expect(Array.from(read).length).toBe(8000);
  expect(richOf({ details: "😀".repeat(6000) }, new Set())?.details).toBe("😀".repeat(6000));
});

test("only ASCII whitespace is trimmed, as ask_ledger.py trims it (P20 round 2)", () => {
  // \x1f is whitespace to Python's strip() and not to JS's trim(): both readers now keep it, so both refuse the path.
  expect(mediaOf([{ kind: "image", path: "docs/a.png\u001f" }], 4)).toEqual([]);
  expect(mediaOf([{ kind: "image", path: "  docs/a.png\t" }], 4)).toEqual([
    { kind: "image", path: "docs/a.png", url: null, caption: null },
  ]);
});

describe("files that are not plain files (P20 round 3)", () => {
  test("a FIFO named as media is refused at once, never opened to wait for a writer", async () => {
    const repo = await scratch();
    await mkdir(join(repo, "docs"));
    const fifo = join(repo, "docs", "stall.png");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const started = Date.now();
    await expect(readInside(repo, "docs/stall.png", 100)).rejects.toThrow(/not a file/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
  test("a hard link to a file outside the home is refused", async () => {
    const outside = await scratch();
    await writeFile(join(outside, "secret.png"), PNG);
    const repo = await scratch();
    await mkdir(join(repo, "docs"));
    await link(join(outside, "secret.png"), join(repo, "docs", "hard.png"));
    await expect(readInside(repo, "docs/hard.png", 100)).rejects.toThrow(/hard link/);
  });
  test("a meta with a stray quote is taken out too", () => {
    const locked = lockedHtml("<meta http-equiv=refresh content=0;url=https://e/ x=a'b><p>x</p>");
    expect(locked).not.toContain("https://e/");
  });
  test("a URL with a character outside printable ASCII is not shown (as ask_ledger.py refuses it)", () => {
    expect(mediaOf([{ kind: "image", url: "https://e/x\uFEFF" }], 4)).toEqual([]);
    expect(mediaOf([{ kind: "image", url: "https://e/x%EF%BB%BF.png" }], 4)).toHaveLength(1);
  });
});

describe("which ask an attachment request names (P20 round 1)", () => {
  const ask = (id: string, uid: string | null, hash = "h", refusal: string | null = null) => ({
    ledger: "l.yaml",
    id,
    uid,
    hash,
    refusal,
  });
  const at = (uid: string | null, id: string, hash = "h") => ({ ledger: "l.yaml", uid, id, hash });
  test("the uid and the id must both match", () => {
    const all = [ask("A", "U"), ask("B", "U2")];
    expect(() => attachmentAsk(all, at("U", "B"))).toThrow(/no longer holds/);
    expect(attachmentAsk(all, at("U", "A")).id).toBe("A");
  });
  test("twins sharing a handle, a refused ask, and an ask changed since it was read serve nothing", () => {
    expect(() => attachmentAsk([ask("A", "U"), ask("A", "U")], at("U", "A"))).toThrow(/Two asks/);
    expect(() => attachmentAsk([ask("A", null), ask("A", null)], at(null, "A"))).toThrow(/Two asks/);
    expect(() => attachmentAsk([ask("A", null, "h", "Two asks share A")], at(null, "A"))).toThrow(/Two asks share A/);
    expect(() => attachmentAsk([ask("A", null, "h2")], at(null, "A"))).toThrow(/changed since/);
  });
});

describe("paths and lengths, as the validator reads them (P20 round 1)", () => {
  test("a media path with an anchor or a control character is not shown, and never read", async () => {
    expect(mediaOf([{ kind: "image", path: "nothere.png#/../.env" }], 4)).toEqual([]);
    expect(mediaOf([{ kind: "image", path: "a\norigin/main:b.png" }], 4)).toEqual([]);
    const repo = await scratch();
    await writeFile(join(repo, ".env"), "SECRET=1");
    await expect(readInside(repo, "nothere.png#/../.env", 100)).rejects.toThrow(/not a path inside/);
  });
  test("a cap counts whitespace runs as one space, as ask_ledger.py does", () => {
    const summary = `${"word ".repeat(120)}${"  ".repeat(60)}end.`;
    expect(summary.length).toBeGreaterThan(700);
    expect(richOf({ summary }, new Set())?.summary).toBe(summary.trim());
  });
});
