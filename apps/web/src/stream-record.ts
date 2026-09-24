import {
  EventStreamVerifier,
  type BufferMutation,
  type RecordManifest,
  type VerificationResult,
} from "../../../packages/format/src/index.ts";

export const EVENT_PAGE_SIZE = 4096;
export const OVERVIEW_BINS = 128;
export type OverviewBin = {
  start: number;
  end: number;
  count: number;
  minimum_length: number | null;
  maximum_length: number | null;
};
export type RecordOverview = {
  bins: OverviewBin[];
  first_t: number | null;
  last_t: number | null;
  known_length_events: number;
};
export type EventPage = {
  events: BufferMutation[];
  next_offset: number | null;
  total_events: number;
  chain_tip_before: string | null;
  chain_tip_after: string;
};
export type StreamProgress = { count: number; overview: RecordOverview };

/** One bounded page and one fixed-size overview; no accumulated event history. */
export async function verifyPagedRecord(
  manifest: RecordManifest,
  readPage: (offset: number, limit: number) => Promise<EventPage>,
  progress?: (value: StreamProgress) => void,
): Promise<{ verification: VerificationResult; overview: RecordOverview }> {
  const verifier = new EventStreamVerifier(manifest);
  const duration = Math.max(1, manifest.duration_ms);
  const overview: RecordOverview = {
    bins: Array.from({ length: OVERVIEW_BINS }, (_, i) => ({
      start: (duration * i) / OVERVIEW_BINS,
      end: (duration * (i + 1)) / OVERVIEW_BINS,
      count: 0,
      minimum_length: null,
      maximum_length: null,
    })),
    first_t: null,
    last_t: null,
    known_length_events: 0,
  };
  let length: number | null = 0;
  while (verifier.eventCount < manifest.event_count) {
    const offset = verifier.eventCount;
    const page = await readPage(offset, EVENT_PAGE_SIZE);
    if (
      !Array.isArray(page.events) ||
      page.events.length === 0 ||
      page.events.length > EVENT_PAGE_SIZE ||
      page.total_events !== manifest.event_count
    ) {
      throw new Error("Invalid event page size or record count");
    }
    if (page.chain_tip_before !== verifier.chainTip)
      throw new Error("Event page does not continue the verified prefix");
    for (const event of page.events) {
      verifier.append(event);
      overview.first_t ??= event.t;
      overview.last_t = event.t;
      const bin =
        overview.bins[
          Math.min(
            OVERVIEW_BINS - 1,
            Math.floor((event.t / duration) * OVERVIEW_BINS),
          )
        ]!;
      bin.count++;
      if (
        length !== null &&
        event.pos !== null &&
        event.del_len !== null &&
        event.ins_len !== null &&
        event.pos + event.del_len <= length
      ) {
        length += event.ins_len - event.del_len;
        overview.known_length_events++;
        bin.minimum_length = Math.min(bin.minimum_length ?? length, length);
        bin.maximum_length = Math.max(bin.maximum_length ?? length, length);
      } else length = null;
    }
    if (page.chain_tip_after !== verifier.chainTip)
      throw new Error("Event page hash does not match its events");
    const expectedNext =
      verifier.eventCount === manifest.event_count ? null : verifier.eventCount;
    if (page.next_offset !== expectedNext)
      throw new Error("Event page cursor is inconsistent");
    if (
      verifier.eventCount % (EVENT_PAGE_SIZE * 16) === 0 ||
      expectedNext === null
    ) {
      progress?.({ count: verifier.eventCount, overview });
    }
  }
  return { verification: verifier.finish(), overview };
}
