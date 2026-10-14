export interface Side {
  monthlyAllowance: number;
  maxPerRequest: number;
  consumed: number;
}

export type Decision =
  | { accepted: true }
  | {
      accepted: false;
      rejectedBy: "user" | "account";
      rule: "max_per_request" | "monthly_allowance";
      limit: number;
    };

export function remaining(side: Side): number {
  return Math.max(0, side.monthlyAllowance - side.consumed);
}

export function evaluate(units: number, user: Side, account: Side): Decision {
  if (units > user.maxPerRequest) {
    return { accepted: false, rejectedBy: "user", rule: "max_per_request", limit: user.maxPerRequest };
  }
  if (units > account.maxPerRequest) {
    return { accepted: false, rejectedBy: "account", rule: "max_per_request", limit: account.maxPerRequest };
  }
  if (units > remaining(user)) {
    return { accepted: false, rejectedBy: "user", rule: "monthly_allowance", limit: user.monthlyAllowance };
  }
  if (units > remaining(account)) {
    return { accepted: false, rejectedBy: "account", rule: "monthly_allowance", limit: account.monthlyAllowance };
  }
  return { accepted: true };
}