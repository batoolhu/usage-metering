import { Router } from "express";
import { requireApiKey } from "./auth";
import { consume, UserNotFoundError, RequestConflictError } from "./consume";

export const consumeRouter = Router();

consumeRouter.post("/v1/consume", requireApiKey, async (req, res) => {
  const { user_id, units, request_id } = req.body ?? {};

  if (typeof user_id !== "string" || user_id.trim() === "") {
    return res.status(400).json({ error: "user_id is required" });
  }
  if (!Number.isSafeInteger(units) || units <= 0) {
    return res.status(400).json({ error: "units must be a positive whole number" });
  }
  if (typeof request_id !== "string" || request_id.trim() === "") {
    return res.status(400).json({ error: "request_id is required" });
  }

  try {
    const result = await consume({
      accountId: req.account!.id,
      userExternalId: user_id.trim(),
      units,
      requestId: request_id.trim(),
    });
    res.json(result);
  } catch (e) {
    if (e instanceof UserNotFoundError) {
      return res.status(404).json({ error: "user not found" });
    }
    if (e instanceof RequestConflictError) {
      return res.status(409).json({
        error: "request_id was already used with a different user or units",
      });
    }
    throw e;
  }
});