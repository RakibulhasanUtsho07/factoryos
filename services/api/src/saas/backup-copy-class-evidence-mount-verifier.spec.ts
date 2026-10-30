import { isPathOnReadOnlyLinuxMount } from './backup-copy-class-evidence-mount-verifier';

describe('isPathOnReadOnlyLinuxMount', () => {
  const rootRw = '24 1 8:1 / / rw,relatime - ext4 /dev/root rw,errors=remount-ro';

  it('accepts a read-only deepest mount covering the evidence root', () => {
    const mountInfo = [
      rootRw,
      '40 24 8:1 /secure-evidence /var/lib/factoryos/evidence ro,nosuid,nodev - ext4 /dev/root rw,errors=remount-ro',
    ].join('\n');
    expect(isPathOnReadOnlyLinuxMount('/var/lib/factoryos/evidence', mountInfo)).toBe(true);
    expect(isPathOnReadOnlyLinuxMount('/var/lib/factoryos/evidence/packs/item.bin', mountInfo)).toBe(true);
  });

  it('rejects a writable deeper bind mount over a read-only parent', () => {
    const mountInfo = [
      rootRw,
      '40 24 8:1 /secure-evidence /var/lib/factoryos/evidence ro,nosuid,nodev - ext4 /dev/root rw,errors=remount-ro',
      '41 40 8:2 / /var/lib/factoryos/evidence/pack.bin rw,nosuid - ext4 /dev/evidence rw',
    ].join('\n');
    expect(isPathOnReadOnlyLinuxMount('/var/lib/factoryos/evidence/pack.bin', mountInfo)).toBe(false);
  });

  it('decodes escaped mount points and respects path boundaries', () => {
    const mountInfo = [
      rootRw,
      '40 24 8:1 /evidence /mnt/secure\\040evidence ro,nosuid - ext4 /dev/root rw',
    ].join('\n');
    expect(isPathOnReadOnlyLinuxMount('/mnt/secure evidence/item.bin', mountInfo)).toBe(true);
    expect(isPathOnReadOnlyLinuxMount('/mnt/secure evidence-evil/item.bin', mountInfo)).toBe(false);
  });

  it('fails closed when no mount matches, the target is not absolute, or input is malformed', () => {
    expect(isPathOnReadOnlyLinuxMount('/unmounted/evidence', rootRw)).toBe(false);
    expect(isPathOnReadOnlyLinuxMount('relative/evidence', rootRw)).toBe(false);
    expect(isPathOnReadOnlyLinuxMount('/tmp/evidence', 'not a mountinfo line')).toBe(false);
  });

  it('does not substitute superblock read-only metadata for a per-mount ro option', () => {
    const mountInfo = '40 24 8:1 / /evidence rw,nosuid - ext4 /dev/evidence ro';
    expect(isPathOnReadOnlyLinuxMount('/evidence/item.bin', mountInfo)).toBe(false);
  });

  it('fails closed on duplicate deepest mount points if any candidate is writable', () => {
    const mountInfo = [
      '40 24 8:1 / /evidence ro,nosuid - ext4 /dev/evidence rw',
      '41 24 8:2 / /evidence rw,nosuid - ext4 /dev/other rw',
    ].join('\n');
    expect(isPathOnReadOnlyLinuxMount('/evidence/item.bin', mountInfo)).toBe(false);
  });
});
