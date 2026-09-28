import React, { useCallback } from 'react';
import { TripSession, UserSettings } from '../types';
import { parseBackup, formatDateRange, pluralTrips } from '../utils/backup';
import { useFeedback } from '../components/ui/Feedback';
import { triggerHaptic } from '../utils/haptics';

export type ImportMode = 'replace' | 'merge';

/**
 * Shared "restore from JSON file" flow for History and Settings:
 * read → validate → show what's inside → let the user choose replace / merge / cancel.
 * The actual state change (and the "Отменить" toast) lives in App.handleImportBackup.
 */
export function useBackupImport(
  onImportBackup: (sessions: TripSession[], settings: UserSettings | undefined, mode: ImportMode) => void,
  currentCount: number,
  hapticFeedback: boolean,
) {
  const { ask, toast } = useFeedback();

  return useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => {
      toast({ message: 'Не удалось прочитать файл.', tone: 'error' });
      input.value = '';
    };
    reader.onload = async (event) => {
      // Reset so picking the same file again still fires onChange.
      input.value = '';
      const result = parseBackup(String(event.target?.result ?? ''));
      if (result.ok === false) {
        toast({ message: result.error, tone: 'error', durationMs: 5000 });
        return;
      }
      const { backup } = result;
      const range = formatDateRange(backup.dateRange);

      const choice = await ask({
        title: 'Восстановить из файла',
        message: (
          <div className="space-y-1.5">
            <div>В файле: <b>{pluralTrips(backup.sessions.length)}</b>{range ? ` (${range})` : ''}.</div>
            <div>Сейчас в приложении: <b>{pluralTrips(currentCount)}</b>.</div>
            {backup.skipped > 0 && (
              <div className="text-amber-500">Пропущено повреждённых записей: {backup.skipped}.</div>
            )}
            <div className="pt-1 opacity-80">
              «Добавить» оставит ваши записи и добавит только новые. «Заменить» удалит текущие поездки
              {backup.settings ? ' и настройки' : ''} и загрузит данные из файла.
            </div>
          </div>
        ),
        actions: [
          { id: 'merge', label: 'Добавить недостающие (рекомендуется)', tone: 'primary' },
          { id: 'replace', label: 'Заменить всё данными из файла', tone: 'danger' },
          { id: 'cancel', label: 'Отмена', tone: 'neutral' },
        ],
      });

      if (choice !== 'merge' && choice !== 'replace') return;
      triggerHaptic('success', hapticFeedback);
      onImportBackup(backup.sessions, backup.settings as UserSettings | undefined, choice);
    };
    reader.readAsText(file);
  }, [ask, toast, onImportBackup, currentCount, hapticFeedback]);
}
