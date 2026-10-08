import type { Metadata } from "next";
import { StudentSearch } from "@/components/evaluator/student-search";
import { PageHeader } from "@/components/shared/ui-bits";
import { stringParam } from "@/lib/format";

export const metadata: Metadata = { title: "Find Student" };

export default async function SearchPage({ searchParams }: PageProps<"/evaluator/search">) {
  const sp = await searchParams;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Find Student"
        description="Search by register number, name or email. Each student can be evaluated by only one evaluator."
      />
      <StudentSearch autoFocus initialQuery={stringParam(sp.q)} />
    </div>
  );
}
