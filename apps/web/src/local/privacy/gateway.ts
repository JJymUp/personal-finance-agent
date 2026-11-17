import {
  RunRequestSchema,
  SafeToolResultSchema,
  FollowUpRequestSchema,
  type AuthorizationScopeName,
  type RunRequest,
  type SafeToolResult,
  type FollowUpRequest,
} from '@maggot/contracts';

export interface AuthorizationScope {
  purpose: 'financial_planning';
  provider: string; // e.g. 'mock_provider' or 'openai:gpt-5.6-luna'
  allowedScopes: AuthorizationScopeName[];
  expiresAt: string;
}

export class PrivacyGateway {
  private activeAuthorization: AuthorizationScope | null = null;
  private auditLog: Array<{
    timestamp: string;
    action: string;
    payloadType: string;
    details: string;
  }> = [];

  authorize(scope: AuthorizationScope): void {
    this.activeAuthorization = {
      ...scope,
      allowedScopes: [...new Set(scope.allowedScopes)],
    };
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'AUTHORIZATION_GRANTED',
      payloadType: 'AUTH_SCOPE',
      details: `Provider: ${scope.provider}, Scopes: ${this.activeAuthorization.allowedScopes.join(',')}`,
    });
  }

  revoke(): void {
    this.activeAuthorization = null;
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'AUTHORIZATION_REVOKED',
      payloadType: 'AUTH_SCOPE',
      details: 'All outgoing authorizations revoked',
    });
  }

  getActiveAuthorization(): AuthorizationScope | null {
    if (!this.activeAuthorization) return null;
    if (Date.parse(this.activeAuthorization.expiresAt) <= Date.now()) {
      return null;
    }
    return {
      ...this.activeAuthorization,
      allowedScopes: [...this.activeAuthorization.allowedScopes],
    };
  }

  hasScope(scope: AuthorizationScopeName): boolean {
    const auth = this.getActiveAuthorization();
    if (!auth) return false;
    return auth.allowedScopes.includes(scope);
  }

  isAuthorized(
    provider: string,
    requiredScopes: AuthorizationScopeName[] = []
  ): boolean {
    if (!this.activeAuthorization) return false;
    if (this.activeAuthorization.purpose !== 'financial_planning') return false;
    if (this.activeAuthorization.provider !== provider) return false;
    const expiresMs = Date.parse(this.activeAuthorization.expiresAt);
    if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) return false;
    if (this.activeAuthorization.allowedScopes.length === 0) return false;
    for (const s of requiredScopes) {
      if (!this.activeAuthorization.allowedScopes.includes(s)) {
        return false;
      }
    }
    return true;
  }

  getAuditLog() {
    return [...this.auditLog];
  }

  /**
   * Outbound inspection for RunRequest.
   * Enforces explicit scope authorization (R03), strict schema (P-02), and sensitive token scan.
   */
  inspectAndAuthorizeRunRequest(request: unknown, targetProvider: string): RunRequest {
    const required: AuthorizationScopeName[] = ['profile_summary', 'goal_summary', 'scenarios'];
    if (!this.isAuthorized(targetProvider, required)) {
      throw new Error(
        `Unauthorized: Missing active authorization or required scopes (${required.join(', ')}) for provider ${targetProvider}`
      );
    }

    // 1. Strict Schema Validation (Zod rejects unknown properties & client-supplied runId)
    const validated = RunRequestSchema.parse(request);

    // R03: Reject family_burden_category unless family_summary scope is explicitly granted
    if (
      validated.safeProfileSummary.family_burden_category !== undefined &&
      !this.hasScope('family_summary')
    ) {
      throw new Error(
        'Scope Violation (R03 / P-04): family_burden_category cannot leave browser without explicit family_summary scope'
      );
    }

    // 2. Sensitive pattern scan on serialized payload (P-01 ~ P-09)
    const serialized = JSON.stringify(validated);
    this.assertNoSensitiveTokens(serialized);

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'OUTBOUND_RUN_REQUEST_APPROVED',
      payloadType: 'RunRequest',
      details: `candidateScenarios: ${validated.candidateScenarios.length}, scopes: ${this.activeAuthorization?.allowedScopes.join(',')}`,
    });

    return validated;
  }

  /**
   * Outbound inspection for SafeToolResult (discriminated union by toolName + versionBinding).
   */
  inspectAndAuthorizeToolResult(result: unknown, targetProvider: string): SafeToolResult {
    const validated = SafeToolResultSchema.parse(result);
    const requiredScope: AuthorizationScopeName =
      validated.toolName === 'request_clarification' ? 'clarification' : 'scenarios';

    if (!this.isAuthorized(targetProvider, [requiredScope])) {
      throw new Error(
        `Unauthorized: Missing required scope (${requiredScope}) for provider ${targetProvider}`
      );
    }

    const serialized = JSON.stringify(validated);
    this.assertNoSensitiveTokens(serialized);

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'OUTBOUND_TOOL_RESULT_APPROVED',
      payloadType: 'SafeToolResult',
      details: `tool: ${validated.toolName}, callId: ${validated.callId}, status: ${validated.status}`,
    });

    return validated;
  }

  /**
   * R01 / P-03 Outbound inspection for structured post-report follow-up intents.
   * Free-text questions are completely disallowed; only closed enum FollowUpIntent + valid scenario IDs pass.
   */
  inspectAndAuthorizeFollowUp(
    request: unknown,
    targetProvider: string,
    allowedScenarioIds?: string[]
  ): FollowUpRequest {
    if (!this.isAuthorized(targetProvider, ['follow_up'])) {
      throw new Error(
        `Unauthorized: Missing follow_up scope authorization for provider ${targetProvider}`
      );
    }

    const validated = FollowUpRequestSchema.parse(request);

    if (allowedScenarioIds && allowedScenarioIds.length > 0) {
      if (
        validated.selectedScenarioId &&
        !allowedScenarioIds.includes(validated.selectedScenarioId)
      ) {
        throw new Error(
          `Privacy Violation (R01): Unknown selectedScenarioId "${validated.selectedScenarioId}"`
        );
      }
      if (validated.focusScenarioId && !allowedScenarioIds.includes(validated.focusScenarioId)) {
        throw new Error(
          `Privacy Violation (R01): Unknown focusScenarioId "${validated.focusScenarioId}"`
        );
      }
    }

    const serialized = JSON.stringify(validated);
    this.assertNoSensitiveTokens(serialized);

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      action: 'OUTBOUND_FOLLOWUP_APPROVED',
      payloadType: 'FollowUpRequest',
      details: `intent: ${validated.intent}`,
    });

    return validated;
  }

  /**
   * Assert that payload does not contain forbidden raw financial data or tokens.
   */
  private assertNoSensitiveTokens(jsonString: string): void {
    // Forbidden keywords or synthetic test tokens
    const forbiddenPatterns = [
      /SENSITIVE_/i,
      /CONFIDENTIAL_/i,
      /ACCOUNT_NO/i,
      /CARD_NO/i,
      /PASSWORD/i,
      /PASSPHRASE/i,
      /SECRET_KEY/i,
      /API_KEY/i,
      /BANK_/i,
    ];

    for (const pattern of forbiddenPatterns) {
      if (pattern.test(jsonString)) {
        throw new Error(`Security Violation: Outbound payload contains forbidden token pattern: ${pattern}`);
      }
    }
  }
}
