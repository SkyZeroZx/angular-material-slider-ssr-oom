import { Routes } from '@angular/router';
import { PriceBand } from './price-band/price-band';
import { PriceRange } from './price-range/price-range';

export const routes: Routes = [
  { path: '', component: PriceRange },
  { path: 'band', component: PriceBand },
];
