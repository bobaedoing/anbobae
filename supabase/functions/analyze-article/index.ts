// analyze-article 함수
//
// 신문 기사 사진(1장 이상)을 받아서 OpenAI Responses API로 분석하고,
// news-archive 앱의 등록 폼과 동일한 구조(title/date/press/category/region/
// keywords/bon/kkae/jeok)로 결과를 JSON으로 돌려준다.
//
// 이 파일은 Supabase 쪽 코드이며, news-archive 앱 프론트엔드는 아직 이 함수를
// 호출하지 않는다. (5단계: Edge Function 단독 동작 확인까지만)

// ---------------------------------------------------------------------------
// 사용할 모델 이름을 한 곳에 모아둔다. 나중에 실제로 호출해보고
// "model not found" 같은 오류가 나면 이 상수만 바꾸면 된다.
// (요청하신 대로 gpt-5.6-luna로 설정했지만, 이 모델 ID가 OpenAI 계정에서
//  실제로 사용 가능한지는 아직 확인되지 않았다 — 5단계 테스트 호출로 확인 예정.)
// ---------------------------------------------------------------------------
const OPENAI_MODEL = "gpt-5.6-luna";

// news-archive 앱에서 쓰는 카테고리와 동일하게 맞춘다.
const CATEGORY_OPTIONS = ["부동산", "사업", "경제", "투자", "정책", "사회", "기타"];

// OpenAI Structured Outputs(json_schema)에 사용할 스키마.
// strict 모드에서는 정의된 모든 속성이 반드시 required에 포함되어야 하므로,
// "확인 불가능하면 빈 문자열"이라는 규칙은 값 자체를 빈 문자열("")로 채우는
// 방식으로 표현한다 (필드 자체를 생략하지 않음).
const ARTICLE_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "기사 제목. 확인 불가능하면 빈 문자열." },
    date: { type: "string", description: "기사 날짜(YYYY-MM-DD 형식 권장). 확인 불가능하면 빈 문자열." },
    press: { type: "string", description: "언론사명. 확인 불가능하면 빈 문자열." },
    category: { type: "string", enum: CATEGORY_OPTIONS },
    region: { type: "string", description: "기사와 관련된 지역. 특정 지역이 없으면 빈 문자열." },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "핵심 키워드 목록. 없으면 빈 배열.",
    },
    bon: { type: "string", description: "기사에서 실제로 확인되는 핵심 사실만. 추측 금지." },
    kkae: { type: "string", description: "그 사실이 왜 중요한지, 어떤 의미/변화를 갖는지. 사실과 해석을 구분해서 서술." },
    jeok: { type: "string", description: "사업/투자/부동산/의사결정 관점에서 실제로 참고하거나 추적할 관점. 무조건 투자를 권하는 식으로 쓰지 않음." },
  },
  required: ["title", "date", "press", "category", "region", "keywords", "bon", "kkae", "jeok"],
  additionalProperties: false,
};

const ANALYSIS_INSTRUCTIONS = `당신은 신문 기사 스크랩을 정리하는 리서치 보조원입니다.
아래 사진들은 하나의 신문 기사를 여러 장으로 나누어 찍은 것일 수 있습니다.
모든 사진을 하나의 기사로 합쳐서 읽고, 다음 규칙을 지켜 분석 결과를 작성하세요.

[본/깨/적 작성 원칙]
- "본"에는 사진 속 기사에서 실제로 확인되는 사실만 적습니다. 기사에 나오지 않은 내용을 추측해서 채우지 마세요.
- "깨"에는 그 사실이 왜 중요한지, 어떤 의미나 변화를 갖는지를 적되, 사실(fact)과 해석(interpretation)을 명확히 구분해서 서술하세요.
- "적"은 "무조건 매수/투자하라" 같은 단정적 권유가 아니라, 사업/투자/부동산/의사결정 관점에서 실제로 참고하거나 추적해볼 만한 관점으로 작성하세요.
- 사진 속 글자가 흐릿하거나 기사 내용이 불명확하면, 억지로 채우지 말고 해당 필드를 빈 문자열(또는 빈 배열)로 남겨두세요.

[다른 필드]
- title: 기사 제목
- date: 기사 날짜 (확인 가능하면 YYYY-MM-DD 형식으로)
- press: 언론사명
- category: 부동산 / 사업 / 경제 / 투자 / 정책 / 사회 / 기타 중 가장 알맞은 하나
- region: 기사와 관련된 지역 (특정 지역이 없으면 빈 문자열)
- keywords: 핵심 키워드 배열

반드시 한국어로 작성하고, 정의된 JSON 구조 그대로만 응답하세요.`;

Deno.serve(async (req) => {
  // ---------------------------------------------------------------------
  // CORS: 지금은 테스트 단계라 모든 출처를 허용한다.
  // ⚠️ 나중에 실제 사용자에게 공개 배포하기 전에는, 이 "*"를 news-archive
  //    앱이 실제로 서비스되는 도메인으로 좁혀서 보안을 강화해야 한다.
  // ---------------------------------------------------------------------
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
    return jsonResponse({ ok: false, error: "POST 요청만 지원합니다." }, 405);
  }

  // ---------------------------------------------------------------------
  // 1. 요청 바디 파싱 및 검증
  //    { images: ["data:image/jpeg;base64,...", "data:image/png;base64,..."] }
  // ---------------------------------------------------------------------
  let images: string[] = [];
  try {
    const body = await req.json();
    images = Array.isArray(body?.images) ? body.images : [];
  } catch {
    return jsonResponse({ ok: false, error: "요청 본문이 올바른 JSON이 아닙니다." }, 400);
  }

  if (images.length === 0) {
    return jsonResponse({ ok: false, error: "분석할 이미지가 1장 이상 필요합니다." }, 400);
  }

  const invalidImage = images.find(
    (src) => typeof src !== "string" || !src.startsWith("data:image/")
  );
  if (invalidImage !== undefined) {
    return jsonResponse(
      { ok: false, error: "이미지는 data:image/... 형식의 base64 문자열이어야 합니다." },
      400
    );
  }

  // ---------------------------------------------------------------------
  // 2. OPENAI_API_KEY 확인 — 실제 키 값은 코드에 절대 넣지 않고,
  //    Supabase Secret에서만 읽어온다.
  // ---------------------------------------------------------------------
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    // 키가 없다는 사실만 알리고, 다른 민감 정보는 노출하지 않는다.
    return jsonResponse(
      { ok: false, error: "서버에 OPENAI_API_KEY가 설정되어 있지 않습니다." },
      500
    );
  }

  // ---------------------------------------------------------------------
  // 3. OpenAI Responses API 호출
  // ---------------------------------------------------------------------
  const content: Record<string, unknown>[] = [
    { type: "input_text", text: ANALYSIS_INSTRUCTIONS },
  ];
  for (const dataUri of images) {
    content.push({ type: "input_image", image_url: dataUri });
  }

  const openaiPayload = {
    model: OPENAI_MODEL,
    input: [{ role: "user", content }],
    reasoning: {
      effort: "low",
    },
    text: {
      format: {
        type: "json_schema",
        name: "article_analysis",
        schema: ARTICLE_ANALYSIS_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: 2000,
    store: false,
  };

  let openaiRes: Response;
  try {
    openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(openaiPayload),
    });
  } catch (err) {
    console.error("OpenAI 호출 자체가 실패했습니다:", err);
    return jsonResponse(
      { ok: false, error: "AI 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요." },
      502
    );
  }

  if (!openaiRes.ok) {
    // OpenAI가 돌려준 오류 본문은 서버 로그에만 남기고, 사용자에게는
    // 민감정보 없는 일반적인 메시지만 돌려준다.
    const errText = await openaiRes.text().catch(() => "");
    console.error("OpenAI API 오류:", openaiRes.status, errText);
    return jsonResponse(
      { ok: false, error: `AI 분석 요청이 실패했습니다. (status: ${openaiRes.status})` },
      502
    );
  }

  let openaiData: any;
  try {
    openaiData = await openaiRes.json();
  } catch (err) {
    console.error("OpenAI 응답 JSON 파싱 실패:", err);
    return jsonResponse({ ok: false, error: "AI 응답을 해석하지 못했습니다." }, 502);
  }

  // ---------------------------------------------------------------------
  // 4. 구조화된 결과 텍스트 추출
  //    Responses API 응답 형태가 버전에 따라 조금씩 다를 수 있어,
  //    여러 경로를 순서대로 시도해서 실제 텍스트를 찾는다.
  // ---------------------------------------------------------------------
  function extractOutputText(data: any): string | null {
    if (typeof data?.output_text === "string" && data.output_text.length > 0) {
      return data.output_text;
    }
    const output = Array.isArray(data?.output) ? data.output : [];
    for (const item of output) {
      const contentList = Array.isArray(item?.content) ? item.content : [];
      for (const c of contentList) {
        if (typeof c?.text === "string" && c.text.length > 0) {
          return c.text;
        }
      }
    }
    return null;
  }

  const rawText = extractOutputText(openaiData);
  if (!rawText) {
    console.error("OpenAI 응답에서 결과 텍스트를 찾지 못했습니다:", JSON.stringify(openaiData));
    return jsonResponse({ ok: false, error: "AI 분석 결과를 읽어오지 못했습니다." }, 502);
  }

  let result: Record<string, unknown>;
  try {
    result = JSON.parse(rawText);
  } catch (err) {
    console.error("AI 결과 JSON 파싱 실패:", err, rawText);
    return jsonResponse({ ok: false, error: "AI 분석 결과 형식이 올바르지 않습니다." }, 502);
  }

  return jsonResponse({ ok: true, result });
});
