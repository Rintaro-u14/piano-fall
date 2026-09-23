import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MIDI_BYTES = 20 * 1024 * 1024;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const ALLOWED_HOSTS = ["bitmidi.com", "midiworld.com", "midisfree.com", "mididb.com", "getuploader.com"];

function checkedUrl(value: string) {
  if (value.length > 2048 || /[\\\u0000-\u001f]/.test(value)) throw new Error("配布ページのURLが正しくありません。");
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || !ALLOWED_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error("対応していない配布サイトのURLです。");
  }
  url.hash = "";
  return url.toString();
}

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

function textContent(value: string) {
  return decodeHtml(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function pageLinks(html: string) {
  const links: { text: string; href: string }[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2] ?? match[1].match(/\bhref\s*=\s*([^\s>]+)/i)?.[1];
    if (href) links.push({ text: textContent(match[2]), href: decodeHtml(href) });
  }
  return links;
}

function pageTitle(html: string) {
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1];
  const emphasis = heading?.match(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/i)?.[1];
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  return textContent(emphasis || heading || title || "");
}

function uploaderDownloadForm(html: string) {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)) {
    if (!/\bmethod\s*=\s*(["']?)post\1/i.test(form[1])) continue;
    const token = form[2].match(/<input\b(?=[^>]*\bname\s*=\s*(["'])token\1)[^>]*\bvalue\s*=\s*(["'])(.*?)\2/i)?.[3];
    const submit = form[2].match(/<input\b(?=[^>]*\bname\s*=\s*(["'])yes\1)[^>]*\bvalue\s*=\s*(["'])(.*?)\2/i)?.[3];
    if (token && submit) return new URLSearchParams({ token: decodeHtml(token), yes: decodeHtml(submit) }).toString();
  }
  return null;
}

function midiName(value: string) {
  let name = value.replace(/\\/g, "/").split("/").pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) || "Downloaded.mid";
  try { name = decodeURIComponent(name); } catch { /* keep the original filename */ }
  if (!/\.midi?$/i.test(name)) name += ".mid";
  return name;
}

function dispositionName(value: string | null) {
  if (!value) return "";
  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) return midiName(encoded.replace(/^"|"$/g, ""));
  const plain = value.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  return plain ? midiName((plain[1] || plain[2]).trim()) : "";
}

async function readLimited(response: Response, maxBytes: number) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("MIDI ファイルが大きすぎます（上限20MB）。");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(maxBytes === MAX_MIDI_BYTES ? "MIDI ファイルが大きすぎます（上限20MB）。" : "配布ページが大きすぎます。");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function fetchProvider(url: string, formBody?: string, cookieJar?: string) {
  let current = checkedUrl(url);
  let method = formBody ? "POST" : "GET";
  let body = formBody;
  let cookies = cookieJar || "";
  for (let hop = 0; hop < 6; hop += 1) {
    const currentHost = new URL(current).hostname.toLowerCase();
    const sendCookies = currentHost === "getuploader.com" || currentHost.endsWith(".getuploader.com");
    const response = await fetch(current, {
      redirect: "manual",
      method,
      body,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PianoFall/2.0; +midi-import)",
        Accept: "audio/midi,audio/x-midi,application/octet-stream,text/html,application/xhtml+xml;q=0.8,*/*;q=0.2",
        "Accept-Encoding": "identity",
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(sendCookies && cookies ? { Cookie: cookies } : {}),
      },
      signal: AbortSignal.timeout(12000),
      cache: "no-store",
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";", 1)[0];
      const key = pair.split("=", 1)[0];
      const retained = cookies.split(/;\s*/).filter((item) => item.split("=", 1)[0] !== key && item);
      cookies = [...retained, pair].join("; ");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("配布サイトの転送先が見つかりません。");
      current = checkedUrl(new URL(location, current).toString());
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`配布サイトから取得できませんでした（HTTP ${response.status}）。`);
    }
    const contentType = response.headers.get("content-type") || "";
    const filename = dispositionName(response.headers.get("content-disposition"));
    const bytes = await readLimited(response, contentType.includes("html") ? MAX_PAGE_BYTES : MAX_MIDI_BYTES);
    return { bytes, url: current, contentType, filename, cookie: cookies };
  }
  throw new Error("転送が多すぎるため取得できませんでした。");
}

function extractCandidates(html: string, baseUrl: string) {
  const candidates: string[] = [];
  for (const { text, href } of pageLinks(html)) {
    if (!href) continue;
    let url: URL;
    try { url = new URL(href, baseUrl); } catch { continue; }
    const path = url.pathname.toLowerCase();
    const label = text.toLocaleLowerCase();
    if (/\.(?:mid|midi)$/i.test(path) || /\/midi-download\/[^/]+\.(?:mid|midi)$/i.test(path) || /\/download\/\d+\/?$/i.test(path) || url.searchParams.has("wpdmdl") || ["download", "download free midi", "free download"].includes(label)) {
      try { candidates.push(checkedUrl(url.toString())); } catch { /* ignore external links */ }
    }
  }
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const value = decodeHtml(match[0]).replace(/[),.;]+$/, "");
    if (!/\.midi?(?:[?#]|$)|wpdmdl=|\/midi-download\//i.test(value)) continue;
    try { candidates.push(checkedUrl(value)); } catch { /* ignore external links */ }
  }
  return [...new Set(candidates)].sort((a, b) => {
    const score = (value: string) => {
      const url = new URL(value);
      return (url.pathname.toLowerCase().endsWith(".mid") || url.pathname.toLowerCase().endsWith(".midi") ? 0 : 1)
        + (url.pathname.toLowerCase().includes("/midi-download/") ? 0 : 1)
        + (url.pathname.toLowerCase().includes("/download/") ? 0 : 1);
    };
    return score(a) - score(b);
  });
}

async function downloadMidi(initialUrl: string, suggestedName: string) {
  let current = checkedUrl(initialUrl);
  let title = suggestedName;
  const visited = new Set<string>();
  let formBody: string | undefined;
  let cookie: string | undefined;
  for (let depth = 0; depth < 4; depth += 1) {
    const response = await fetchProvider(current, formBody, cookie);
    cookie = response.cookie;
    formBody = undefined;
    if (response.bytes.byteLength >= 4 && new TextDecoder().decode(response.bytes.subarray(0, 4)) === "MThd") {
      return { bytes: response.bytes, name: response.filename || midiName(title || new URL(response.url).pathname.split("/").pop() || "Downloaded.mid") };
    }
    const html = new TextDecoder().decode(response.bytes);
    title ||= pageTitle(html);
    const finalUrl = response.url;
    if (visited.has(finalUrl)) break;
    visited.add(finalUrl);
    const uploaderPage = new URL(finalUrl).hostname.toLowerCase().endsWith("getuploader.com");
    const uploaderForm = uploaderPage && uploaderDownloadForm(html);
    if (uploaderForm) {
      current = finalUrl;
      formBody = uploaderForm;
      continue;
    }
    let candidates = extractCandidates(html, finalUrl).filter((candidate) => !visited.has(candidate));
    const final = new URL(finalUrl);
    const uploaderId = final.pathname.match(/^\/by_cif\/download\/(\d+)\/?$/i)?.[1];
    if (!candidates.length && uploaderId && /\.midi?$/i.test(title)) {
      candidates = [`https://ux.getuploader.com/by_cif/download/${uploaderId}/${encodeURIComponent(title)}`];
    }
    if (!candidates.length) break;
    current = candidates[0];
  }
  throw new Error("この配布ページからMIDIを取得できませんでした。別の候補をお試しください。");
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { url?: unknown; name?: unknown };
    if (typeof body.url !== "string" || typeof body.name !== "string") {
      return NextResponse.json({ error: "MIDI の候補情報が正しくありません。" }, { status: 400 });
    }
    const url = checkedUrl(body.url);
    const name = midiName(body.name);
    const midi = await downloadMidi(url, name);
    return new Response(midi.bytes, {
      headers: {
        "Content-Type": "audio/midi",
        "Content-Length": String(midi.bytes.byteLength),
        "Content-Disposition": `attachment; filename="midi.mid"; filename*=UTF-8''${encodeURIComponent(midi.name)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "MIDIを取得できませんでした。" }, { status: 400 });
  }
}
