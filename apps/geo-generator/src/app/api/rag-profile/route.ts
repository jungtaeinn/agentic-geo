import { proxyPythonAgent } from "../../lib/python-agent-client";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return proxyPythonAgent(request, "/rag-profile");
}

export async function PUT(request: Request): Promise<Response> {
  return proxyPythonAgent(request, "/rag-profile");
}

export async function DELETE(request: Request): Promise<Response> {
  return proxyPythonAgent(request, "/rag-profile");
}
