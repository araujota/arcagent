"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { BOUNTY_CREATION_TOS } from "@/lib/legal/bounty-creation-tos";
import { ScrollArea } from "@/components/ui/scroll-area";

export function BountyTosModal({ children }: { children: React.ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Bounty Creation Terms of Service</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Version {BOUNTY_CREATION_TOS.version} — Effective{" "}
            {BOUNTY_CREATION_TOS.effectiveDate}
          </p>
        </DialogHeader>
        <ScrollArea className="flex-1 pr-4 -mr-4">
          <div className="space-y-6 pb-4">
            {BOUNTY_CREATION_TOS.sections.map((section) => (
              <div key={section.title}>
                <h3 className="font-semibold text-sm mb-2">{section.title}</h3>
                <p className="text-sm text-muted-foreground whitespace-pre-line leading-relaxed">
                  {section.content}
                </p>
              </div>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
