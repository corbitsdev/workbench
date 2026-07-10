import { downloadActivityExportCsv } from "../../lib/hub-api";
import type { ActivityExportBucket } from "../../lib/hub-api";
import type { DateRange } from "./time-range";

export function triggerActivityCsvDownload(
  tenantId: string,
  dates: DateRange,
  bucket: ActivityExportBucket,
): void {
  void downloadActivityExportCsv(tenantId, { ...dates, bucket })
    .then(({ csv, filename }) => {
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    })
    .catch(() => {});
}
