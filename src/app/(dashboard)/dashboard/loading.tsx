import { StatsSkeleton, CardGridSkeleton } from "@/components/shared/loading-skeleton";

export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      <StatsSkeleton />
      <CardGridSkeleton count={6} />
    </div>
  );
}
