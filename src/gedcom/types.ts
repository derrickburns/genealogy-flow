export interface SourceRef {
  src_id: string;
  page: string;
  text: string;
  url: string | null;
}

export interface Event {
  tag: string;
  date: string;
  year: number | null;
  place: string;
  note: string;
  sources: SourceRef[];
}

export interface Individual {
  id: string;
  raw: string;
  name: string;
  sex: string;
  famc: string | null;
  fams: string[];
  events: Event[];
  notes: string[];
  sources: SourceRef[];
}

export interface Family {
  id: string;
  husb: string | null;
  wife: string | null;
  chil: string[];
  marr: Event | null;
  div: Event | null;
}

export interface Source {
  id: string;
  title: string;
  auth: string;
  publ: string;
  note: string;
}

export interface Gedcom {
  individuals: Map<string, Individual>;
  families: Map<string, Family>;
  sources: Map<string, Source>;
}

export const EVENT_TAGS: ReadonlySet<string> = new Set([
  "BIRT", "DEAT", "RESI", "MARR", "EMIG", "IMMI", "CENS", "BAPM",
  "BURI", "CHR", "OCCU", "EDUC", "RELI", "NATU", "WILL",
]);
