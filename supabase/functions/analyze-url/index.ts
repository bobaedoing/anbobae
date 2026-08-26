// analyze-url 함수
//
// 사용자가 붙여넣은 "온라인 기사 URL"을 서버에서 안전하게 읽어와서,
// 기사 제목/언론사/날짜/canonical URL/본문 텍스트를 추출해 돌려준다.
//
// 이번 단계에서는 OpenAI 분석을 아직 호출하지 않는다 (다음 단계에서 이 결과를
// analyze-article과 동일한 AI 분석 로직에 넘기는 함수를 따로 만들 예정).
// 그래서 AI 사용량(profiles.monthly_limit) 차감도 이번 단계에서는 하지 않는다 —
// 로그인 여부만 analyze-article과 동일한 방식(getClaims)으로 확인한다.
//
// 기사 원문 전체는 어디에도 영구 저장하지 않는다. 이 함수는 요청이 들어올 때마다
// 그 자리에서 fetch해서 분석용 텍스트만 응답으로 돌려주고, 그 외에는 아무것도 남기지 않는다.

import { createClient } from "npm:@supabase/supabase-js@2";
import { parseHTML } from "npm:linkedom@0.18.13";

// ---------------------------------------------------------------------------
// 안전 관련 기본값
// ---------------------------------------------------------------------------
const MAX_REDIRECTS = 5;               // 이 횟수를 넘는 리다이렉트는 거부한다.
const FETCH_TIMEOUT_MS = 15_000;       // 리다이렉트를 포함한 전체 요청에 허용하는 최대 시간(15초).
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024; // 3MB. 뉴스 기사 페이지는 보통 이보다 훨씬 작다.
const MIN_ARTICLE_TEXT_LENGTH = 200;   // 이보다 짧게 추출되면 "본문을 못 찾은 것"으로 본다.
const FETCH_USER_AGENT =
  "news-archive-bot/1.0 (+https://bobaedoing.github.io/anbobae/)";

// ---------------------------------------------------------------------------
// 이 함수 전용 오류 타입. { code, message, httpStatus }를 한 번에 들고 다니다가
// 맨 위 핸들러에서 한 번에 JSON 응답으로 바꾼다.
// ---------------------------------------------------------------------------
class AnalyzeUrlError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// IPv4/IPv6 파싱 + 차단 대역 검사
// (SSRF 방어의 핵심 — "이 IP로는 서버가 절대 접속하면 안 된다"를 판단한다)
// ---------------------------------------------------------------------------
function parseIPv4(input: string): number[] | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => {
    if (!/^\d{1,3}$/.test(p)) return NaN;
    const n = Number(p);
    return n >= 0 && n <= 255 ? n : NaN;
  });
  if (nums.some((n) => Number.isNaN(n))) return null;
  return nums;
}

function ipv4ToInt(octets: number[]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function ipv4InCidr(ipInt: number, baseOctets: number[], maskBits: number): boolean {
  const baseInt = ipv4ToInt(baseOctets);
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

// 요청하신 대역(0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16)에
// 더해, 방어 차원에서 흔히 같이 막는 몇 개 대역(멀티캐스트/예약/브로드캐스트 등)도 포함했다.
const BLOCKED_IPV4_CIDRS: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8],        // 0.0.0.0/8
  [[10, 0, 0, 0], 8],       // 10.0.0.0/8 (사설망)
  [[100, 64, 0, 0], 10],    // 100.64.0.0/10 (CGNAT)
  [[127, 0, 0, 0], 8],      // 127.0.0.0/8 (loopback)
  [[169, 254, 0, 0], 16],   // 169.254.0.0/16 (link-local, 169.254.169.254 클라우드 메타데이터 포함)
  [[172, 16, 0, 0], 12],    // 172.16.0.0/12 (사설망)
  [[192, 168, 0, 0], 16],   // 192.168.0.0/16 (사설망)
  [[192, 0, 0, 0], 24],     // IETF 프로토콜 예약 대역 (보너스)
  [[192, 0, 2, 0], 24],     // TEST-NET-1 (보너스)
  [[198, 18, 0, 0], 15],    // 벤치마킹용 예약 대역 (보너스)
  [[224, 0, 0, 0], 4],      // 멀티캐스트 (보너스)
  [[240, 0, 0, 0], 4],      // 예약 대역 (보너스)
  [[255, 255, 255, 255], 32], // 브로드캐스트 (보너스)
];

function isBlockedIPv4(ipInt: number): boolean {
  return BLOCKED_IPV4_CIDRS.some(([base, bits]) => ipv4InCidr(ipInt, base, bits));
}

// 최소한의 IPv6 파서. 완벽한 스펙 준수보다는, "이상하면 파싱 실패 → 안전하게 차단"
// 방향으로 동작하게 만들었다 (실패를 열어두지 않고 닫는 쪽으로).
function parseIPv6(input: string): Uint8Array | null {
  let addr = input;
  const pct = addr.indexOf("%");
  if (pct !== -1) addr = addr.slice(0, pct); // zone id(%eth0 등) 제거

  if (!addr) return null;

  const sides = addr.split("::");
  if (sides.length > 2) return null;

  const toGroups = (s: string): string[] => (s === "" ? [] : s.split(":"));

  // 끝부분이 "1.2.3.4" 같은 IPv4 임베디드 표기(::ffff:1.2.3.4 등)면 16진수 두 그룹으로 변환한다.
  const expandV4Tail = (groups: string[]): string[] | null => {
    if (groups.length === 0) return groups;
    const last = groups[groups.length - 1];
    if (!last.includes(".")) return groups;
    const v4 = parseIPv4(last);
    if (!v4) return null;
    const hex1 = ((v4[0] << 8) | v4[1]).toString(16);
    const hex2 = ((v4[2] << 8) | v4[3]).toString(16);
    return [...groups.slice(0, -1), hex1, hex2];
  };

  let head = expandV4Tail(toGroups(sides[0]));
  let tail = sides.length === 2 ? expandV4Tail(toGroups(sides[1])) : [];
  if (head === null || tail === null) return null;

  const total = head.length + tail.length;
  let fullGroups: string[];
  if (sides.length === 1) {
    if (total !== 8) return null;
    fullGroups = head;
  } else {
    if (total > 7) return null; // "::"가 최소 한 그룹은 채워야 함
    fullGroups = [...head, ...Array(8 - total).fill("0"), ...tail];
  }
  if (fullGroups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = fullGroups[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const val = parseInt(g, 16);
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }
  return bytes;
}

function isBlockedIPv6(bytes: Uint8Array): boolean {
  // :: (unspecified)
  if (bytes.every((b) => b === 0)) return true;
  // ::1 (loopback)
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  // fe80::/10 (link-local)
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // fc00::/7 (Unique Local Address, 사설 IPv6)
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  // ::ffff:0:0/96 (IPv4-mapped) — 내부에 담긴 IPv4 주소를 다시 IPv4 규칙으로 검사한다.
  const isV4Mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isV4Mapped) {
    const v4 = [bytes[12], bytes[13], bytes[14], bytes[15]];
    return isBlockedIPv4(ipv4ToInt(v4));
  }
  return false;
}

// ---------------------------------------------------------------------------
// URL 하나가 안전한 fetch 대상인지 검사한다. (프로토콜 → credential → hostname
// 리터럴 → 도메인이면 실제 DNS 조회 결과까지) 리다이렉트를 한 번 따라갈 때마다
// 이 함수를 다시 통과시켜야 한다.
// ---------------------------------------------------------------------------
async function assertUrlIsSafe(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AnalyzeUrlError("INVALID_URL", "올바른 URL 형식이 아닙니다.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AnalyzeUrlError("PROTOCOL_NOT_ALLOWED", "http 또는 https 주소만 사용할 수 있습니다.");
  }

  if (parsed.username || parsed.password) {
    throw new AnalyzeUrlError("CREDENTIALS_NOT_ALLOWED", "로그인 정보가 포함된 URL은 사용할 수 없습니다.");
  }

  // new URL()이 "0x7f000001" 같은 IPv4의 다른 표기법(16진수/8진수/정수 등)을
  // 표준 점(.) 표기로 정규화해주기 때문에, 아래에서는 이 hostname 값만 검사하면 된다.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new AnalyzeUrlError("HOST_NOT_ALLOWED", "localhost 주소는 사용할 수 없습니다.");
  }

  const literalV4 = parseIPv4(hostname);
  if (literalV4) {
    if (isBlockedIPv4(ipv4ToInt(literalV4))) {
      throw new AnalyzeUrlError("HOST_NOT_ALLOWED", "이 주소로는 기사를 가져올 수 없습니다.");
    }
    return parsed;
  }

  const literalV6 = parseIPv6(hostname);
  if (literalV6) {
    if (isBlockedIPv6(literalV6)) {
      throw new AnalyzeUrlError("HOST_NOT_ALLOWED", "이 주소로는 기사를 가져올 수 없습니다.");
    }
    return parsed;
  }

  // 여기까지 왔으면 hostname은 IP 리터럴이 아니라 도메인이다.
  // 도메인이 사설/루프백 IP로 연결되는 경우(DNS 리바인딩 등)를 막기 위해,
  // 실제 DNS 조회 결과까지 확인한다. 조회 자체가 실패하면 안전하게 차단한다.
  let resolvedIps: string[] = [];
  try {
    const [v4Result, v6Result] = await Promise.allSettled([
      Deno.resolveDns(hostname, "A"),
      Deno.resolveDns(hostname, "AAAA"),
    ]);
    if (v4Result.status === "fulfilled") resolvedIps.push(...v4Result.value);
    if (v6Result.status === "fulfilled") resolvedIps.push(...v6Result.value);
  } catch (err) {
    console.error("DNS 조회 중 오류:", err);
    throw new AnalyzeUrlError("DNS_RESOLUTION_FAILED", "주소를 확인하지 못했습니다.");
  }

  if (resolvedIps.length === 0) {
    throw new AnalyzeUrlError("DNS_RESOLUTION_FAILED", "주소를 확인하지 못했습니다.");
  }

  for (const ip of resolvedIps) {
    const v4 = parseIPv4(ip);
    if (v4) {
      if (isBlockedIPv4(ipv4ToInt(v4))) {
        throw new AnalyzeUrlError("HOST_NOT_ALLOWED", "이 주소로는 기사를 가져올 수 없습니다.");
      }
      continue;
    }
    const v6 = parseIPv6(ip);
    if (v6 && isBlockedIPv6(v6)) {
      throw new AnalyzeUrlError("HOST_NOT_ALLOWED", "이 주소로는 기사를 가져올 수 없습니다.");
    }
  }

  // ⚠️ 알려진 한계: 여기서 확인한 IP와, 실제 fetch()가 연결할 때 다시 조회하는 IP가
  // 이론적으로 다를 수 있다(DNS TTL이 아주 짧은 경우의 rebinding). 이를 완전히 막으려면
  // 미리 확인한 IP로 직접 소켓을 열고 TLS SNI/인증서를 직접 다뤄야 하는데, 이번 단계
  // 범위를 넘어서는 작업이라 포함하지 않았다 — 실제 서비스 확장 시 재검토가 필요하다.
  return parsed;
}

// ---------------------------------------------------------------------------
// 응답 본문을 스트리밍으로 읽으면서, 실제로 읽은 바이트 수가 제한을 넘으면 즉시 중단한다.
// (Content-Length 헤더는 속이거나 생략될 수 있으므로 그것만 믿지 않는다.)
// ---------------------------------------------------------------------------
async function readBodyWithLimit(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AnalyzeUrlError("RESPONSE_TOO_LARGE", "응답 크기가 너무 큽니다.", 413);
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

// ---------------------------------------------------------------------------
// URL을 안전하게 fetch하고, 리다이렉트를 수동으로 따라가며 매번 다시 검증한다.
// ---------------------------------------------------------------------------
async function fetchArticleHtmlSafely(
  inputUrl: string,
): Promise<{ finalUrl: string; html: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let currentUrl = inputUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertUrlIsSafe(currentUrl);

      let res: Response;
      try {
        res = await fetch(currentUrl, {
          redirect: "manual", // 자동으로 따라가지 않고, 매번 우리가 직접 검증한 뒤 이동한다.
          signal: controller.signal,
          headers: {
            "User-Agent": FETCH_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
          },
        });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          throw new AnalyzeUrlError("TIMEOUT", "기사 페이지를 불러오는 데 시간이 너무 오래 걸립니다.", 504);
        }
        throw new AnalyzeUrlError("FETCH_FAILED", "기사 페이지에 연결하지 못했습니다.", 502);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          throw new AnalyzeUrlError("FETCH_FAILED", "리다이렉트 응답이 올바르지 않습니다.", 502);
        }
        if (hop === MAX_REDIRECTS) {
          throw new AnalyzeUrlError("TOO_MANY_REDIRECTS", "리다이렉트가 너무 많습니다.", 502);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue; // 다음 루프에서 이 새 주소를 다시 assertUrlIsSafe로 검증한다.
      }

      if (!res.ok) {
        throw new AnalyzeUrlError(
          "FETCH_FAILED",
          `기사 페이지를 불러오지 못했습니다. (status: ${res.status})`,
          502,
        );
      }

      const contentType = res.headers.get("content-type") || "";
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        throw new AnalyzeUrlError(
          "UNSUPPORTED_CONTENT_TYPE",
          "HTML로 된 기사 페이지만 분석할 수 있습니다.",
          415,
        );
      }

      const declaredLength = Number(res.headers.get("content-length") || "0");
      if (declaredLength && declaredLength > MAX_RESPONSE_BYTES) {
        throw new AnalyzeUrlError("RESPONSE_TOO_LARGE", "응답 크기가 너무 큽니다.", 413);
      }

      const html = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
      return { finalUrl: currentUrl, html };
    }

    throw new AnalyzeUrlError("TOO_MANY_REDIRECTS", "리다이렉트가 너무 많습니다.", 502);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HTML에서 기사 정보 추출 (JSON-LD → Open Graph/meta → canonical → 본문 후보 순)
// 정규식만으로 전체 HTML을 다루지 않고, linkedom으로 실제 DOM을 만들어 querySelector로 찾는다.
// ---------------------------------------------------------------------------
function normalizeDate(raw?: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// JSON-LD는 JSON.parse()로 읽기 때문에, 원문 JSON 문자열 안에 &quot; 같은 HTML
// entity가 문자 그대로 박혀있는 사이트(예: 뉴시스)는 파싱 후에도 entity가 남는다.
// linkedom이 이미 갖고 있는 HTML 파싱 규칙(innerHTML → textContent)을 그대로
// 재사용해서 디코딩한다 — 별도 entity 매핑 테이블/라이브러리를 새로 추가하지 않는다.
// (DOM에서 직접 뽑는 값들, 예: extractBodyText()의 textContent나 meta의
//  getAttribute()는 파싱 시점에 이미 디코딩되어 있으므로 여기서 다시 건드리지 않는다.)
function decodeHtmlEntities(text: string, doc: Document): string {
  const el = doc.createElement("div");
  el.innerHTML = text;
  return el.textContent ?? text;
}

function extractFromJsonLd(doc: Document): { title?: string; press?: string; date?: string | null; text?: string } {
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
  for (const script of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(script.textContent || "");
    } catch {
      continue;
    }
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as any)?.["@graph"])
      ? (data as any)["@graph"]
      : [data];

    for (const item of list) {
      const rawType = (item as any)?.["@type"];
      const types = Array.isArray(rawType) ? rawType : [rawType];
      const isArticle = types.some(
        (t) => typeof t === "string" && /newsarticle|article/i.test(t),
      );
      if (!isArticle) continue;

      const obj = item as Record<string, unknown>;
      const title = typeof obj.headline === "string" ? decodeHtmlEntities(obj.headline, doc) : undefined;
      const publisher = obj.publisher as { name?: string } | undefined;
      const press = typeof publisher?.name === "string" ? decodeHtmlEntities(publisher.name, doc) : undefined;
      const dateRaw =
        typeof obj.datePublished === "string"
          ? obj.datePublished
          : typeof obj.dateModified === "string"
          ? obj.dateModified
          : undefined;
      const text = typeof obj.articleBody === "string" ? decodeHtmlEntities(obj.articleBody, doc) : undefined;

      return { title, press, date: normalizeDate(dateRaw), text };
    }
  }
  return {};
}

function extractFromMeta(doc: Document): { title?: string; press?: string; date?: string | null } {
  const getContent = (selector: string) =>
    doc.querySelector(selector)?.getAttribute("content") || undefined;

  return {
    title: getContent('meta[property="og:title"]') || getContent('meta[name="twitter:title"]'),
    press: getContent('meta[property="og:site_name"]'),
    date: normalizeDate(getContent('meta[property="article:published_time"]')),
  };
}

function extractCanonicalUrl(doc: Document, fallbackUrl: string): string {
  const href = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  if (!href) return fallbackUrl;
  try {
    return new URL(href, fallbackUrl).toString();
  } catch {
    return fallbackUrl;
  }
}

// script/style/nav/footer 등과, 흔한 광고·메뉴용 class/id 패턴을 최대한 제거한 뒤
// 남은 텍스트를 본문 후보로 쓴다. 완벽한 추출이 목표가 아니라, AI가 분석하기에
// "충분히 깨끗한" 텍스트 확보가 목표다.
const NOISE_TAGS = ["script", "style", "noscript", "nav", "footer", "header", "aside", "iframe", "form"];
const NOISE_PATTERN =
  /(^|[-_ ])(ad|ads|advert|banner|gnb|lnb|snb|nav|menu|footer|header|sidebar|share|sns|comment|related|copyright)([-_ ]|$)/i;

function extractBodyText(doc: Document): string {
  for (const tag of NOISE_TAGS) {
    Array.from(doc.querySelectorAll(tag)).forEach((el) => el.remove());
  }
  Array.from(doc.querySelectorAll("[class], [id]")).forEach((el) => {
    const attr = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`;
    if (NOISE_PATTERN.test(attr)) el.remove();
  });

  const container =
    doc.querySelector("article") || doc.querySelector('[itemprop="articleBody"]') || doc.body;

  return (container?.textContent || "").replace(/\s+/g, " ").trim();
}

function extractArticleInfo(html: string, finalUrl: string) {
  const { document } = parseHTML(html);

  const jsonLd = extractFromJsonLd(document);
  const meta = extractFromMeta(document);
  const canonicalUrl = extractCanonicalUrl(document, finalUrl);

  const title = jsonLd.title || meta.title || document.querySelector("title")?.textContent?.trim() || null;
  const press = jsonLd.press || meta.press || null;
  const date = jsonLd.date || meta.date || null;

  // JSON-LD의 articleBody가 있고 충분히 길면 그대로 쓰고, 아니면 DOM에서 본문 후보를 뽑는다.
  let text = jsonLd.text && jsonLd.text.trim().length >= MIN_ARTICLE_TEXT_LENGTH ? jsonLd.text.trim() : "";
  if (!text) {
    text = extractBodyText(document);
  }

  return { title, press, date, canonicalUrl, text };
}

// ---------------------------------------------------------------------------
// 인증용 Supabase 클라이언트 — analyze-article과 동일한 방식(getClaims)만 쓴다.
// 이번 단계는 AI를 호출하지 않으므로 profiles/사용량 관련 로직은 없다.
// ---------------------------------------------------------------------------
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, code: "METHOD_NOT_ALLOWED", error: "POST 요청만 지원합니다." }, 405);
  }

  // ---------------------------------------------------------------------
  // 0. 로그인 확인 — analyze-article과 완전히 동일한 방식.
  // ---------------------------------------------------------------------
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";

  if (!token) {
    return jsonResponse({ ok: false, code: "UNAUTHENTICATED", error: "로그인이 필요합니다." }, 401);
  }

  try {
    const { data: claimsData, error: claimsError } = await supabaseAdmin.auth.getClaims(token);
    const claims = claimsData?.claims;
    if (claimsError || !claims || claims.role !== "authenticated" || !claims.sub) {
      return jsonResponse({ ok: false, code: "UNAUTHENTICATED", error: "로그인이 필요합니다." }, 401);
    }
  } catch (err) {
    console.error("토큰 검증 중 오류:", err);
    return jsonResponse({ ok: false, code: "UNAUTHENTICATED", error: "로그인이 필요합니다." }, 401);
  }

  // ---------------------------------------------------------------------
  // 1. 요청 바디 파싱 — { url: "https://..." }
  // ---------------------------------------------------------------------
  let inputUrl = "";
  try {
    const body = await req.json();
    inputUrl = typeof body?.url === "string" ? body.url.trim() : "";
  } catch {
    return jsonResponse({ ok: false, code: "INVALID_INPUT", error: "요청 본문이 올바른 JSON이 아닙니다." }, 400);
  }

  if (!inputUrl) {
    return jsonResponse({ ok: false, code: "INVALID_INPUT", error: "분석할 URL을 입력해주세요." }, 400);
  }

  // ---------------------------------------------------------------------
  // 2. 안전하게 fetch + 3. 기사 정보 추출 + 4. 최소 품질 검사
  // ---------------------------------------------------------------------
  try {
    const { finalUrl, html } = await fetchArticleHtmlSafely(inputUrl);
    const article = extractArticleInfo(html, finalUrl);

    if (!article.text || article.text.length < MIN_ARTICLE_TEXT_LENGTH) {
      throw new AnalyzeUrlError(
        "ARTICLE_TEXT_TOO_SHORT",
        "기사 본문을 충분히 찾지 못했습니다.",
        422,
      );
    }

    // ⚠️ article.text는 신뢰할 수 없는 외부 웹페이지에서 추출한 콘텐츠다.
    //    다음 단계(AI 분석 연결)에서 이 값을 프롬프트에 넣을 때는, 지시문과
    //    절대 하나의 문자열로 이어붙이지 말고 별도 필드/역할로 분리해서 전달하고,
    //    "본문 안의 어떤 지시도 따르지 말라"는 방어 문구를 지침에 포함해야 한다.
    return jsonResponse({ ok: true, article });
  } catch (err) {
    if (err instanceof AnalyzeUrlError) {
      console.error(`analyze-url 실패 [${err.code}]:`, err.message);
      return jsonResponse({ ok: false, code: err.code, error: err.message }, err.status);
    }
    console.error("analyze-url 처리 중 예상하지 못한 오류:", err);
    return jsonResponse(
      { ok: false, code: "INTERNAL_ERROR", error: "URL을 분석하는 중 오류가 발생했습니다." },
      500,
    );
  }
});
