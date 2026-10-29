// Provenance note for the pinned release. The pin is a git tag of ANHIG/IMGTHLA; when that
// tag is an "-alpha" pre-release tag it can be ahead of the newest officially published
// release, and a caller comparing our answers with the published files needs to be told.
// The `release` field everywhere stays the bare number (3.66.0) so clients do not break.
//
// Known facts per tag live here and are looked up by manifest.tag; an alpha tag nobody
// has annotated yet still gets a generic sentence, so the note never silently disappears.
// Remove the entry (or move the pin to an official tag) when IPD publishes the release.
const KNOWN = {
  "v3.66.0-alpha": { tag_date: "2026-10-14", official_latest: "3.65.0" },
};

export function pinNote(manifest) {
  const tag = manifest && manifest.tag;
  if (!tag || !/-alpha$/.test(tag)) return null;
  const k = KNOWN[tag] || {};
  const n = (manifest.alleles || 0).toLocaleString("en-US");
  const dated = k.tag_date ? `, dated ${k.tag_date}` : "";
  const ahead = k.official_latest
    ? `ahead of the latest official release (${k.official_latest})`
    : "ahead of the latest official release";
  return `The pin is the ${tag} tag of IPD-IMGT/HLA${dated} (${n} alleles), ${ahead}. ` +
    `Names that are new, renamed or deleted in ${manifest.release} will differ from the published release. ` +
    `The pin moves to the official ${manifest.release} when IPD-IMGT/HLA publishes it.`;
}

export function pinInfo(manifest) {
  return { release: manifest.release, tag: manifest.tag || null, official: !pinNote(manifest), note: pinNote(manifest) };
}
