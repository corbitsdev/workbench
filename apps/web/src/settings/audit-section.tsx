// Workspace audit orientation table. There is no append-only audit log in
// the hub yet — this section is a current-state honesty surface so operators
// know what they are looking at, not a fake evidence trail.

import {
  SettingsPanel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";

import { SETTINGS_STRINGS } from "./strings";

export function AuditSection() {
  return (
    <SettingsPanel
      title={SETTINGS_STRINGS.auditSectionTitle}
      description={SETTINGS_STRINGS.auditSectionDescription}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{SETTINGS_STRINGS.auditWhen}</TableHead>
            <TableHead>{SETTINGS_STRINGS.auditAction}</TableHead>
            <TableHead>{SETTINGS_STRINGS.auditActor}</TableHead>
            <TableHead>{SETTINGS_STRINGS.auditTarget}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell colSpan={4}>
              <p className="settings-field-hint" style={{ margin: 0 }}>
                {SETTINGS_STRINGS.auditEmpty}
              </p>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p className="settings-field-hint">{SETTINGS_STRINGS.auditHonestyNote}</p>
    </SettingsPanel>
  );
}
