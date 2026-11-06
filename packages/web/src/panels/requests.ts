/** Outbox request helpers shared by the outbox panel and DocView (1:1 mt_pr3347g2w2 decision 7: withdrawn and declined requests). */
import type { Doc } from "@muster-town/schema";
import { nameOf } from "./ui";

/** The outbox tab a request sits in: open = Pending, claimed, and done with declined, withdrawn and the legacy rejected (Mitchell, 1:1 mt_6kz0prkq8l: "rejected/withdrawn go under Done"). */
export function requestGroup(status: Doc["requestStatus"]): "open" | "claimed" | "done" {
  return status === "claimed" ? "claimed" : !status || status === "open" ? "open" : "done";
}
/** The pill tone for a request status: the ones that left the outbox undone are bad. */
export function requestTone(status: Doc["requestStatus"]): "ok" | "bad" {
  return status === "rejected" || status === "declined" || status === "withdrawn" ? "bad" : "ok";
}

/** "Declined by Mitchell via Secretary in mt_…: <note>" / "Withdrawn by Pix: <note>" (the note already quotes the human's words when a 1:1 carried it). */
export function requestDecisionLine(doc: Doc, name: (id: string) => string = nameOf): string {
  const who = doc.requestDecidedById ? ` by ${name(doc.requestDecidedById)}${doc.requestViaAgentId ? ` via ${name(doc.requestViaAgentId)}${doc.requestViaMeetingId ? ` in ${doc.requestViaMeetingId}` : ""}` : ""}` : "";
  const verb = doc.requestStatus === "withdrawn" ? "Withdrawn" : doc.requestStatus === "declined" ? "Declined" : "Closed";
  return `${verb}${who}: ${doc.requestNote ?? ""}`;
}
