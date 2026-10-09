import "server-only";
import { cache } from "react";
import { getSettingsRow } from "@/lib/services/settings";

/** Per-request cached settings (event status banner, resubmission flag, …). */
export const getSettings = cache(() => getSettingsRow());
