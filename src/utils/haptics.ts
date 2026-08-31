/**
 * Haptic and sound feedback helper for mobile web
 */
export function triggerHaptic(type: 'light' | 'medium' | 'heavy' | 'success' = 'light', enabled = true) {
  if (!enabled || typeof window === 'undefined') return;

  try {
    if ('vibrate' in navigator) {
      switch (type) {
        case 'light':
          navigator.vibrate(12);
          break;
        case 'medium':
          navigator.vibrate(25);
          break;
        case 'heavy':
          navigator.vibrate(45);
          break;
        case 'success':
          navigator.vibrate([20, 40, 30]);
          break;
      }
    }
  } catch {
    // Ignore vibrate restrictions
  }
}
