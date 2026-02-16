import { Skeleton } from "@/components/ui/skeleton";
import { CardGridSkeleton } from "@/components/shared/loading-skeleton";

export default function BountiesLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="flex gap-2">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-10 w-48" />
      </div>
      <CardGridSkeleton count={6} />
    </div>
  );
}
