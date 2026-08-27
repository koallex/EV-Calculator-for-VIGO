/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import confetti from 'canvas-confetti';
import { motion, AnimatePresence } from 'motion/react';
import { UserSettings, TripSession } from './types';
import {
  DEFAULT_SETTINGS,
  INITIAL_SESSIONS,
  loadSettings,
  saveSettings,
  loadSessions,
  saveSessions,
} from './utils/storage';
import { Header } from './components/Header';
import { Navigation, TabType } from './components/Navigation';
import { CalculatorTab } from './components/CalculatorTab';
import { HudTab } from './components/HudTab';
import { HistoryTab } from './components/HistoryTab';
import { ChargingTab } from './components/ChargingTab';
import { SettingsTab } from './components/SettingsTab';
import { AddTripModal } from './components/AddTripModal';
import { LoginScreen, AuthUser } from './components/LoginScreen';
import { AdminPanel } from './components/AdminPanel';

export default function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [showAdmin, setShowAdmin] = useState(false);
  const [settings, setSettings] = useState<UserSettings>(loadSettings);
  const [sessions, setSessions] = useState<TripSession[]>(loadSessions);
  const [activeTab, setActiveTab] = useState<TabType>('calculator');
  const [isHudTracking, setIsHudTracking] = useState(false);

  // Modals
  const [isAddTripOpen, setIsAddTripOpen] = useState(false);
  const [addTripInitialData, setAddTripInitialData] = useState<Partial<TripSession> | undefined>(undefined);

  // Server-side authentication. No credentials are stored in localStorage.
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('unauthorized');
        const data = await response.json();
        setAuthUser(data.user);
      })
      .catch(() => setAuthUser(null))
      .finally(() => setAuthChecking(false));
  }, []);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      setAuthUser(null);
      setShowAdmin(false);
      setActiveTab('calculator');
    }
  };

  // Sync settings & sessions to localStorage
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);

  // Apply dark / light theme class to root
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'light') {
      root.classList.remove('dark');
      root.classList.add('light');
    } else {
      root.classList.remove('light');
      root.classList.add('dark');
    }
  }, [settings.theme]);

  // Handlers
  const handleSaveTrip = (tripData: Omit<TripSession, 'id' | 'createdAt'>) => {
    const newSession: TripSession = {
      ...tripData,
      id: `trip-${Date.now()}`,
      createdAt: Date.now(),
    };

    setSessions((prev) => [newSession, ...prev]);

    // Celebrate milestone
    try {
      confetti({
        particleCount: 40,
        spread: 60,
        origin: { y: 0.85 },
        colors: ['#06b6d4', '#10b981', '#f59e0b'],
      });
    } catch {
      // Ignore
    }
  };

  const handleDeleteSession = (id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
  };

  const handleResetData = () => {
    setSettings(DEFAULT_SETTINGS);
    setSessions(INITIAL_SESSIONS);
  };

  const handleImportBackup = (
    importedSessions: TripSession[],
    importedSettings?: UserSettings
  ) => {
    if (Array.isArray(importedSessions)) {
      setSessions(importedSessions);
    }
    if (importedSettings) {
      setSettings(importedSettings);
    }
  };

  const openAddModalWithData = (data: Partial<TripSession>) => {
    setAddTripInitialData(data);
    setIsAddTripOpen(true);
  };

  if (authChecking) {
    return <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center text-xs text-slate-400">Проверка авторизации…</div>;
  }

  if (!authUser) {
    return <LoginScreen onLogin={setAuthUser} />;
  }

  return (
    <div className={`min-h-screen transition-colors duration-200 flex flex-col font-sans ${
      settings.theme === 'light' 
        ? 'bg-slate-50 text-slate-900 selection:bg-emerald-500 selection:text-white' 
        : 'bg-slate-950 text-slate-100 selection:bg-emerald-500 selection:text-slate-950'
    }`}>
      {/* Top Header */}
      <Header
        settings={settings}
        onUpdateSettings={setSettings}
        onOpenAddTrip={() => {
          setAddTripInitialData(undefined);
          setIsAddTripOpen(true);
        }}
        currentUser={authUser}
        onOpenAdmin={() => setShowAdmin(true)}
        onLogout={handleLogout}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-3 sm:p-4 mb-16">
        {showAdmin ? (
          <AdminPanel
            currentLogin={authUser.login}
            onClose={() => setShowAdmin(false)}
            onLogout={handleLogout}
          />
        ) : null}

        {!showAdmin && (
        <>
        {/* HUD Tab: Kept mounted permanently so GPS tracking, distance, timer and SoC never reset on tab switch */}
        <div className={activeTab === 'hud' ? 'block animate-in fade-in duration-200' : 'hidden'}>
          <HudTab
            settings={settings}
            sessions={sessions}
            onSaveToHistory={handleSaveTrip}
            onOpenAddModalWithData={openAddModalWithData}
            onTrackingChange={setIsHudTracking}
          />
        </div>

        <AnimatePresence mode="wait">
          {activeTab === 'calculator' && (
            <motion.div
              key="calculator"
              initial={{ opacity: 0, y: 10, filter: 'blur(2px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -8, filter: 'blur(2px)' }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <CalculatorTab
                settings={settings}
                sessions={sessions}
                onSaveToHistory={handleSaveTrip}
                onOpenAddModalWithData={openAddModalWithData}
              />
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 10, filter: 'blur(2px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -8, filter: 'blur(2px)' }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <HistoryTab
                sessions={sessions}
                settings={settings}
                onDeleteSession={handleDeleteSession}
                onOpenAddModal={() => {
                  setAddTripInitialData(undefined);
                  setIsAddTripOpen(true);
                }}
                onImportBackup={handleImportBackup}
              />
            </motion.div>
          )}

          {activeTab === 'charging' && (
            <motion.div
              key="charging"
              initial={{ opacity: 0, y: 10, filter: 'blur(2px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -8, filter: 'blur(2px)' }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <ChargingTab settings={settings} />
            </motion.div>
          )}

          {activeTab === 'settings' && (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 10, filter: 'blur(2px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -8, filter: 'blur(2px)' }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <SettingsTab
                settings={settings}
                sessions={sessions}
                onUpdateSettings={setSettings}
                onResetData={handleResetData}
                onImportBackup={handleImportBackup}
              />
            </motion.div>
          )}
        </AnimatePresence>
        </>
        )}
      </main>

      {/* Bottom Sticky Mobile Navigation */}
      {!showAdmin && <Navigation
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        hapticFeedback={settings.hapticFeedback}
        historyCount={sessions.length}
        theme={settings.theme}
        isHudTracking={isHudTracking}
      />}

      {/* Add Trip Modal */}
      <AddTripModal
        isOpen={isAddTripOpen}
        onClose={() => setIsAddTripOpen(false)}
        settings={settings}
        onSave={handleSaveTrip}
        initialData={addTripInitialData}
      />
    </div>
  );
}
