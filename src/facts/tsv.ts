const escapes: Record<string, string> = {"\\": "\\", "\t": "t", "\n": "n", "\r": "r"};
const unescape: Record<string, string> = {"\\": "\\", t: "\t", n: "\n", r: "\r"};

export function encodeTsv(rows: readonly (readonly string[])[]) {
  return rows.map(row => row.map(field => field.replace(/[\\\t\n\r]/g, char => "\\" + escapes[char])).join("\t") + "\n").join("");
}

export function decodeTsv(text: string) {
  if (!text.length) return [];
  return text.replace(/\r?\n$/, "").split(/\r?\n/).map(line => line.split("\t").map(field => field.replace(/\\([^\r\n]|$)|\r/g, (_, code: string) => {
    if (!Object.hasOwn(unescape, code)) throw new Error("TSV 转义无效。");
    return unescape[code];
  })));
}
