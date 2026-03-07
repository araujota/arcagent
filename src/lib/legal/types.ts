export interface LegalDefinition {
  term: string;
  meaning: string;
}

export interface LegalSection {
  title: string;
  paragraphs: string[];
}

export interface LegalDocumentContent {
  title: string;
  version: string;
  effectiveDate: string;
  summary: string;
  disclaimer?: string;
  highlights?: string[];
  definitions?: LegalDefinition[];
  sections: LegalSection[];
}
