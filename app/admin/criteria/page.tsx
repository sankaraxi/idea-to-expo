import type { Metadata } from "next";
import { CriteriaManager, DomainsManager } from "@/components/admin/criteria-manager";
import { PageHeader } from "@/components/shared/ui-bits";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCriteria, getCriteriaUsage, getDomains } from "@/lib/data/admin";

export const metadata: Metadata = { title: "Criteria & Domains" };

export default async function CriteriaPage() {
  const [criteria, domains, usage] = await Promise.all([getCriteria(), getDomains(), getCriteriaUsage()]);
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title="Criteria & Domains" description="Define how evaluators score each student and which domains they can tag." />
      <Card>
        <CardHeader>
          <CardTitle>Evaluation criteria</CardTitle>
          <CardDescription>
            Each criterion has a maximum mark and an awarding style (stars, slider or number box) shown to evaluators.
            Criteria that already have scores cannot be deleted or have their maximum lowered below a given score — deactivate them instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CriteriaManager criteria={criteria} usage={usage.criteria} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Domains</CardTitle>
          <CardDescription>Evaluators can tick one or more domains related to each idea.</CardDescription>
        </CardHeader>
        <CardContent>
          <DomainsManager domains={domains} usage={usage.domains} />
        </CardContent>
      </Card>
    </div>
  );
}
