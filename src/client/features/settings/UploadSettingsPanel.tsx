import { useEffect, useRef, useState } from 'react';
import type { UploadSettings } from '@shared/types';
import { api } from '../../lib/api';
import { Input, SettingRow, Switch } from '../../components/form';
import { Button } from '../../components/primitives';
import { t } from '../../lib/i18n';

export function UploadSettingsPanel() {
    const [settings, setSettings] = useState<UploadSettings | null>(null);
    const writes = useRef<Promise<void>>(Promise.resolve());
    const [error, setError] = useState('');
    const load = () => {
        setError('');
        void api.settings.uploads().then(setSettings).catch((err: Error) => setError(err.message));
    };
    useEffect(load, []);
    const update = (next: UploadSettings) => {
        setSettings(next);
        if (!Number.isSafeInteger(next.concurrency) || next.concurrency < 1) return;
        setError('');
        writes.current = writes.current.then(() => api.settings.saveUploads(next)).then(
            () => undefined,
            (err) => setError(err instanceof Error ? err.message : t('common.save_failed')),
        );
    };
    return <section>
      <SettingRow title={t('settings.upload_concurrency')} description={t('settings.upload_concurrency_description')}>
        {settings && <Input type="number" min={1} step={1} aria-label={t('settings.upload_concurrency')} className="w-24" value={settings.concurrency} onChange={(event) => update({ ...settings, concurrency: Number(event.target.value) })}/>}
      </SettingRow>
      {settings && <>
        <SettingRow title={t('settings.upload_sync_all')} description={t('settings.upload_sync_all_description')}>
          <Switch label={t('settings.upload_sync_all')} checked={settings.syncToAll} onChange={(syncToAll) => update({ ...settings, syncToAll })}/>
        </SettingRow>
      </>}
      {error && <p role="alert" className="mt-2 text-[12px] text-[var(--danger)]">{error}</p>}
      {!settings && error && <Button size="sm" onClick={load}>{t('common.retry')}</Button>}
    </section>;
}
