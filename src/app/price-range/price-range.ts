import { Component, inject } from '@angular/core';
import { MatSliderModule } from '@angular/material/slider';
import { ActivatedRoute } from '@angular/router';

@Component({
  selector: 'price-range',
  templateUrl: './price-range.html',
  imports: [MatSliderModule],
})
export class PriceRange {
  private readonly params = inject(ActivatedRoute).snapshot.queryParamMap;

  readonly min = Number(this.params.get('min') ?? '0');
  readonly max = Number(this.params.get('max') ?? '100');
  readonly step = Number(this.params.get('step') ?? '1');
  readonly value = Number(this.params.get('value') ?? '0');
  readonly show = this.params.get('show') !== '0';
}
