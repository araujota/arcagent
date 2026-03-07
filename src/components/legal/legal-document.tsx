import type { LegalDocumentContent } from "@/lib/legal/types";

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function LegalDocument({ document }: { document: LegalDocumentContent }) {
  return (
    <div className="bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.16),_transparent_32%),linear-gradient(180deg,_#f8fbfd_0%,_#eff7f9_100%)]">
      <div className="container mx-auto max-w-5xl px-4 py-16 sm:py-20">
        <div className="rounded-[28px] border border-border/70 bg-background/92 p-6 shadow-xl shadow-cyan-950/8 backdrop-blur sm:p-8">
          <div className="space-y-4 border-b border-border/70 pb-8">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-primary">
              Legal
            </p>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                {document.title}
              </h1>
              <p className="max-w-3xl text-sm leading-7 text-muted-foreground sm:text-base">
                {document.summary}
              </p>
            </div>
            <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
              <span className="rounded-full border border-border/70 bg-muted/40 px-3 py-1">
                Version {document.version}
              </span>
              <span className="rounded-full border border-border/70 bg-muted/40 px-3 py-1">
                Effective {document.effectiveDate}
              </span>
            </div>
            {document.disclaimer ? (
              <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
                {document.disclaimer}
              </p>
            ) : null}
          </div>

          {document.highlights?.length ? (
            <section className="border-b border-border/70 py-8">
              <h2 className="text-lg font-semibold text-foreground">Key Points</h2>
              <ul className="mt-4 space-y-3 text-sm leading-7 text-muted-foreground">
                {document.highlights.map((item) => (
                  <li key={item} className="rounded-2xl border border-border/60 bg-muted/30 px-4 py-3">
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {document.definitions?.length ? (
            <section className="border-b border-border/70 py-8">
              <h2 className="text-lg font-semibold text-foreground">Definitions</h2>
              <dl className="mt-4 space-y-4">
                {document.definitions.map((definition) => (
                  <div key={definition.term} className="rounded-2xl border border-border/60 bg-muted/20 px-4 py-3">
                    <dt className="text-sm font-semibold text-foreground">{definition.term}</dt>
                    <dd className="mt-1 text-sm leading-7 text-muted-foreground">
                      {definition.meaning}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          <section className="py-8">
            <div className="mb-6 flex flex-wrap gap-2 text-xs text-muted-foreground">
              {document.sections.map((section) => (
                <a
                  key={section.title}
                  href={`#${slugify(section.title)}`}
                  className="rounded-full border border-border/70 bg-background px-3 py-1.5 hover:text-foreground"
                >
                  {section.title}
                </a>
              ))}
            </div>

            <div className="space-y-8">
              {document.sections.map((section) => (
                <section key={section.title} id={slugify(section.title)} className="scroll-mt-24">
                  <h2 className="text-lg font-semibold text-foreground">{section.title}</h2>
                  <div className="mt-3 space-y-4 text-sm leading-7 text-muted-foreground sm:text-base">
                    {section.paragraphs.map((paragraph) => (
                      <p key={paragraph}>{paragraph}</p>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
