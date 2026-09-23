import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 0;

type SearchResult = { source: string; name: string; pageUrl: string };
type Provider = { name: string; search: (query: string) => Promise<SearchResult[]> };

const PROVIDER_LIMIT = 15;
const RESULT_LIMIT = 40;

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function plainText(value: string) {
  return decodeHtml(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
}

function safeDecode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function queryScore(query: string, name: string) {
  const q = normalize(query);
  const n = normalize(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.includes(q)) return 60;
  return q.split(" ").filter(Boolean).reduce((score, word) => score + (n.includes(word) ? 10 : 0), 0);
}

function anchors(html: string) {
  const result: { text: string; href: string; title: string }[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attribute = (name: string) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return match[1].match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2]
        ?? match[1].match(new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, "i"))?.[1]
        ?? "";
    };
    const href = attribute("href");
    const title = decodeHtml(attribute("title") || attribute("aria-label") || attribute("download"));
    if (href) result.push({ text: plainText(match[2]) || title, href: decodeHtml(href), title });
  }
  return result;
}

async function getHtml(url: string) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PianoFall/2.0; +midi-search)", Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(9000),
    next: { revalidate: 0 },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { html: await response.text(), finalUrl: response.url || url };
}

function result(source: string, name: string, href: string, baseUrl: string): SearchResult | null {
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!["bitmidi.com", "midiworld.com", "midisfree.com", "mididb.com", "getuploader.com"].some((domain) => host === domain || host.endsWith(`.${domain}`))) return null;
    return { source, name: name || "Untitled.mid", pageUrl: url.toString() };
  } catch {
    return null;
  }
}

async function searchMidisFree(query: string) {
  const url = `https://midisfree.com/?${new URLSearchParams({ s: query })}`;
  const { html, finalUrl } = await getHtml(url);
  const output: SearchResult[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors(html)) {
    const path = new URL(anchor.href, finalUrl).pathname.toLowerCase();
    if (!path.startsWith("/download/") || path.startsWith("/downloads/")) continue;
    const fallbackName = `${safeDecode(path.split("/").filter(Boolean).at(-1) ?? "MIDI")}.mid`;
    const row = result("MidisFree", anchor.title || anchor.text || fallbackName, anchor.href, finalUrl);
    if (row && !seen.has(row.pageUrl)) { seen.add(row.pageUrl); output.push(row); }
    if (output.length >= PROVIDER_LIMIT) break;
  }
  return output;
}

async function searchMidiDb(query: string) {
  const url = `https://www.mididb.com/search.asp?${new URLSearchParams({ q: query, formatID: "1" })}`;
  const { html, finalUrl } = await getHtml(url);
  const output: SearchResult[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors(html)) {
    const path = new URL(anchor.href, finalUrl).pathname.toLowerCase();
    if (!path.includes("-midi/") && !path.endsWith("-midi")) continue;
    const row = result("MIDI DB", anchor.title || anchor.text || safeDecode(path.split("/").filter(Boolean).at(-1) ?? "MIDI"), anchor.href, finalUrl);
    if (row && !seen.has(row.pageUrl)) { seen.add(row.pageUrl); output.push(row); }
    if (output.length >= PROVIDER_LIMIT) break;
  }
  return output;
}

async function searchMidiWorld(query: string) {
  const url = `https://www.midiworld.com/search/?${new URLSearchParams({ q: query })}`;
  const { html, finalUrl } = await getHtml(url);
  const output: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    const body = item[1];
    const downloadHref = [...body.matchAll(/<a\b([^>]*)>/gi)].map((match) => match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]).find((href) => href && /\/download\/\d+\/?$/i.test(new URL(href, finalUrl).pathname));
    if (!downloadHref) continue;
    const name = plainText(body).replace(/\s*-?\s*download\b[\s\S]*$/i, "").trim();
    const row = result("MIDI World", name || "MIDI World.mid", downloadHref, finalUrl);
    if (!row) continue;
    if (!seen.has(row.pageUrl)) { seen.add(row.pageUrl); output.push(row); }
    if (output.length >= PROVIDER_LIMIT) break;
  }
  return output;
}

async function searchUploader(query: string) {
  const url = `https://uu.getuploader.com/by_cif/search?${new URLSearchParams({ q: query })}`;
  const { html, finalUrl } = await getHtml(url);
  const output: SearchResult[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors(html)) {
    const name = anchor.title || anchor.text;
    if (!/\.midi?$/i.test(name) || !/^\/by_cif\/download\/\d+\/?$/i.test(new URL(anchor.href, finalUrl).pathname)) continue;
    const row = result("Midi uploader.jp", name, anchor.href, finalUrl);
    if (row && !seen.has(row.pageUrl)) { seen.add(row.pageUrl); output.push(row); }
    if (output.length >= PROVIDER_LIMIT) break;
  }
  return output;
}

const providers: Provider[] = [
  { name: "MIDI World", search: searchMidiWorld },
  { name: "MidisFree", search: searchMidisFree },
  { name: "MIDI DB", search: searchMidiDb },
  { name: "Midi uploader.jp", search: searchUploader },
];

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  if (query.length > 160) return NextResponse.json({ error: "検索語は160文字以内にしてください。" }, { status: 400 });
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return NextResponse.json({ query: normalizedQuery, results: [], providerErrors: [] });

  const settled = await Promise.allSettled(providers.map((provider) => provider.search(normalizedQuery)));
  const providerErrors: string[] = [];
  const providerErrorDetails: { source: string; message: string }[] = [];
  const collected: SearchResult[] = [];
  settled.forEach((item, index) => {
    if (item.status === "fulfilled") collected.push(...item.value);
    else {
      providerErrors.push(providers[index].name);
      providerErrorDetails.push({ source: providers[index].name, message: item.reason instanceof Error ? item.reason.message : "検索先に接続できませんでした。" });
    }
  });

  const seenUrls = new Set<string>();
  const seenNames = new Set<string>();
  const results = collected
    .filter((item) => {
      const nameKey = normalize(item.name.replace(/\.(?:mid|midi)$/i, ""));
      if (seenUrls.has(item.pageUrl) || (nameKey && seenNames.has(nameKey))) return false;
      seenUrls.add(item.pageUrl);
      if (nameKey) seenNames.add(nameKey);
      return true;
    })
    .sort((a, b) => queryScore(normalizedQuery, b.name) - queryScore(normalizedQuery, a.name) || normalize(a.name).localeCompare(normalize(b.name)))
    .slice(0, RESULT_LIMIT);

  return NextResponse.json({ query: normalizedQuery, results, providerErrors, providerErrorDetails, directError: !results.length && providerErrors.length ? "一部の検索先に接続できませんでした。" : null }, { headers: { "Cache-Control": "no-store" } });
}
