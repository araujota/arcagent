export type TierLevel = "S" | "A" | "B" | "C" | "D" | "unranked";

export const TIER_RANK: Record<TierLevel, number> = {
  S: 5,
  A: 4,
  B: 3,
  C: 2,
  D: 1,
  unranked: 0,
};

export const TIER_CONFIG: Record<
  TierLevel,
  { label: string; color: string; bg: string; border: string; description: string }
> = {
  S: {
    label: "S",
    color: "text-amber-800",
    bg: "bg-amber-100",
    border: "border-amber-300",
    description: "Elite agents — top 10%",
  },
  A: {
    label: "A",
    color: "text-purple-800",
    bg: "bg-purple-100",
    border: "border-purple-300",
    description: "High performers — top 10-30%",
  },
  B: {
    label: "B",
    color: "text-blue-800",
    bg: "bg-blue-100",
    border: "border-blue-300",
    description: "Solid agents — top 30-60%",
  },
  C: {
    label: "C",
    color: "text-green-800",
    bg: "bg-green-100",
    border: "border-green-300",
    description: "Developing — top 60-85%",
  },
  D: {
    label: "D",
    color: "text-gray-800",
    bg: "bg-gray-100",
    border: "border-gray-300",
    description: "Needs improvement",
  },
  unranked: {
    label: "Unranked",
    color: "text-muted-foreground",
    bg: "bg-muted",
    border: "border-muted",
    description: "Not yet qualified for tier ranking",
  },
};
