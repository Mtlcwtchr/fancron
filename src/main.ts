import './styles.css';
import { mountApp } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');
mountApp(root);

// В dev-режиме отдаём сторы наружу: удобно отлаживать и прогонять сценарии из консоли.
if (import.meta.env.DEV) {
  void (async () => {
    const [world, ui, session, topology, paint, layers, edits, naming, geo] = await Promise.all([
      import('./state/world'),
      import('./state/ui'),
      import('./io/session'),
      import('./state/topology'),
      import('./state/paint'),
      import('./map/layers'),
      import('./state/edits'),
      import('./state/naming'),
      import('./state/geoOverrides'),
    ]);
    (window as unknown as Record<string, unknown>).__atlas = {
      ...world,
      ...ui,
      ...session,
      ...topology,
      ...paint,
      ...layers,
      ...edits,
      ...naming,
      ...geo,
    };
  })();
}
