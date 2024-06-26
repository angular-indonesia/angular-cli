/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LibComponent } from './lib.component';

describe('LibComponent', () => {
  let component: LibComponent;
  let fixture: ComponentFixture<LibComponent>;

  beforeEach(() => TestBed.configureTestingModule({
    declarations: [LibComponent]
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(LibComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
