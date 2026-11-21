import { readFactFile } from "./commit-files.ts";
import { git, gitOk } from "../taskbook/document.ts";

export function alwaysPrompt(root: string, revision?: string) {
  const path = ".fact/always.tsv";
  const content = revision ? (gitOk(root, "cat-file", "-e", revision + ":" + path) ?
    git(root, "show", revision + ":" + path) : undefined) : readFactFile(root, path)?.trimEnd();
  return content ? "## Project instructions from .fact/always.tsv\n" + content : "";
}
