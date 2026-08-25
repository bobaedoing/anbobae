// analyze-article 함수 — 지금은 테스트용 뼈대입니다.
// 실제로 OpenAI를 호출하지 않고, 함수가 잘 배포됐는지 /
// OPENAI_API_KEY 비밀값을 잘 읽어오는지만 확인합니다.

Deno.serve(async (req) => {
  // 브라우저(news-archive 앱)에서 나중에 바로 호출할 수 있도록 허용
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  // 브라우저가 먼저 보내는 사전 확인 요청 처리
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 키가 설정되어 있는지 여부만 확인 (실제 키 값은 응답에 절대 포함하지 않음)
  const hasKey = Boolean(Deno.env.get("OPENAI_API_KEY"));

  return new Response(
    JSON.stringify({
      ok: true,
      message: "analyze-article 함수가 정상적으로 배포되었습니다.",
      openaiKeyConfigured: hasKey,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
