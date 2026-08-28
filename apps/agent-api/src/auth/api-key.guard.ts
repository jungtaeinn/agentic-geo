import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly expectedKey: string) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.path === "/health") return true;
    if (!this.expectedKey) return true;

    const provided = req.header("x-api-key") ?? "";
    const a = Buffer.from(provided);
    const b = Buffer.from(this.expectedKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("invalid x-api-key");
    }
    return true;
  }
}
