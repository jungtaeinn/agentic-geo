import { proxyPythonAgent } from "../../lib/python-agent-client";

export const maxDuration = 900;

export async function POST(request: Request): Promise<Response> {
  return proxyPythonAgent(request, "/extract");
}
