/**
 * Liveness/readiness endpoint for container orchestration.
 * agent-api와 pdp-geo-api가 같은 경로를 쓰므로 네 앱의 프로브 설정이 동일하다.
 * provider·파일시스템·네트워크를 건드리지 않아, 실패는 Next 서버가 응답을
 * 멈췄다는 뜻만 갖는다.
 */
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
