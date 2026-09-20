import { proxyPythonAgent } from "../../lib/python-agent-client";

export async function POST(request: Request): Promise<Response> {
  return proxyPythonAgent(request, "/evaluation");
}
