import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { AppSettingsRow } from "@/types/database";

/** Settings readable by any signed-in user (RLS allows select on the singleton). */
export const getSettings = cache(async (): Promise<AppSettingsRow> => {
  const supabase = await createClient();
  const { data, error } = await supabase.from("app_settings").select("*").single();
  if (error || !data) throw new Error(`Could not load settings: ${error?.message ?? "missing row"}`);
  return data;
});
