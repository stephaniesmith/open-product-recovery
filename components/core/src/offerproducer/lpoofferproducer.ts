/**
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Offer} from 'opr-models';
import {RandomSeed, create} from 'random-seed';
import {asyncIterableToArray, iterableToAsync} from '../util/asynciterable';
import {Clock} from '../util/clock';
import {DefaultClock} from '../util/defaultclock';
import getUuid from '../util/randomuuid';
import {OfferProducer, OfferSetUpdate} from './offerproducer';
import {IntegrationApi} from '../integrations/integrationapi';

/**
 * A fake offer producer for testing and prototyping. This offer producer
 * maintains a set of psuedo-randomly generated offers. The offer set grows and
 * updates on a configurable schedule. The default implementation creates offers
 * with a fixed structure and rigid update behaviors, but subclasses can
 * override this.
 */
export class LpoOfferProducer implements OfferProducer {
  readonly type = 'offerProducer';

  readonly id: string;
  private locationId: number;                                        // Matt added this
  private clock: Clock;
  private updateChance: number;
  private updateFrequencyMillis: number;
  private newItemFrequencyMillis: number;
  private expirationAgeMillis: number;
  private minOfferCount: number;
  private maxOfferCount: number;
  private integrationApi: IntegrationApi;
  private random: RandomSeed;
  private descTemplates: Array<string>;

  constructor(options: LpoOfferProducerOptions) {
    this.id = 'descriptive id string';
    this.locationId = options.locationId;                             // Matt added this
    this.clock = options.clock ?? new DefaultClock();
    this.updateChance = options.updateChance ?? 0.1;
    this.updateFrequencyMillis = options.updateFrequencyMillis ?? 1000 * 60 * 5;
    this.newItemFrequencyMillis =
      options.newItemFrequencyMillis ?? 1000 * 60 * 10;
    this.expirationAgeMillis =
      options.expirationAgeMillis ?? 1000 * 60 * 60 * 24;
    this.minOfferCount = options.minOfferCount ?? 1;
    this.maxOfferCount = options.maxOfferCount ?? 24;
    this.integrationApi = options.integrationApi;
    this.random = options.random ?? create();
    this.descTemplates = options.descTemplates ?? DEFAULT_DESC_TEMPLATES;
  }

  protected createOffer(): Offer {
    const now = this.clock.now();
    const creationTimeUTC = now;
    const expirationTimeUTC = now + this.expirationAgeMillis;
    const descTemplate =
      this.descTemplates[this.random.range(this.descTemplates.length)];
    const uuid = getUuid(this.random);
    const offer = {
      id: uuid,
      description: `A FAKE OFFER of ${descTemplate}`,
      contents: {
        description: `A wall of ${descTemplate}`,
        quantity: 1,
        packagingType: 'shippingcontainer',
        contents: [
          {
            description: `${descTemplate} on the wall`,
            expirationTimestampUTC: expirationTimeUTC,
            quantity: 99,
          },
        ],
        unitWeight: {
          unit: 'pound',
          value: 40 / 16,
        },
      },
      contactInfo: {
        contactName: 'The Redundant Cowboy Who Is Redundant',
        contactEmail: 'cowboyboots@examplehost.org',
      },
      offerLocation: {
        locationName: "The Ol' Saloon",
        locationAddress: '1 Main Street, Cowpoke Town, Outer Territories',
        accessWindows: [
          {
            startTimeUTC: creationTimeUTC,
            endTimeUTC: expirationTimeUTC,
          },
        ],
      },
      offeredBy: this.id,
      offerExpirationUTC: expirationTimeUTC,
      offerCreationUTC: creationTimeUTC,
    } as Offer;
    return offer;
  }

  protected updateOffer(offer: Offer): void {
    const now = this.clock.now();
    for (const product of offer.contents.contents) {
      let quantity = product.quantity!;
      if (quantity <= 1) {
        quantity = 99;
      } else {
        quantity--;
      }
      product.quantity = quantity;
    }
    offer.offerUpdateUTC = now;
  }

  async produceOffers(/* ignoring all params */): Promise<OfferSetUpdate> {
    const now = this.clock.now();

    const wasteEvents = await fetch(
      'https://7e51-2a00-79e1-abc-1700-855-2bbb-b9f8-c38e.ngrok.io/ccm/rest/v1/system/availableDonations/' + this.locationId,
      {
        method: 'GET',
        mode: 'cors', // not sure if this matters but we are "crossing origins", I believe. no-cors, *cors, same-origin
        cache: 'no-cache',
        credentials: 'same-origin', // are we gonna need to get a current cookie in here for authentication?
      }
    ).then(response => response.json()) as LpoOprDonation[];
    const offers = wasteEvents.map(wasteEvent => this.mapWasteEventToOffer(wasteEvent)) as Offer[]


    // If we don't have enough offers, create the missing ones.
    if (offers.length < this.minOfferCount) {
      console.error(`Bru! You don't have the minimum amount of offers.`);
    }
    // Sort offers by last update time.
    offers.sort((a: Offer, b: Offer) => {
      const aTime = a.offerUpdateUTC ?? a.offerCreationUTC;
      const bTime = b.offerUpdateUTC ?? b.offerCreationUTC;
      return aTime - bTime;
    });
    const newestOffer = offers[offers.length - 1];
    const newestOfferTime =
      newestOffer.offerUpdateUTC ?? newestOffer.offerCreationUTC;
    // If newItemFrequencyMillis has elapsed since the last time we created or
    // updated an offer, create a new offer.
    if (now - newestOfferTime > this.newItemFrequencyMillis) {
      offers.push(this.createOffer());
    }
    // If updateFrequencyMillis has elapsed since the last time we created or
    // updated an offer, give each offer a chance to be updated.
    if (now - newestOfferTime > this.updateFrequencyMillis) {
      for (const offer of offers) {
        if (this.random.random() < this.updateChance) {
          this.updateOffer(offer);
        }
      }
    }
    // If we now have too many offers, delete as many old ones as necessary to
    // get to the required count.
    if (offers.length > this.maxOfferCount) {
      offers.splice(0, offers.length - this.maxOfferCount);
    }
    return {
      offers: iterableToAsync(offers),
      updateCurrentAsOfTimestampUTC: now,
      earliestNextRequestUTC:
        now + Math.min(this.newItemFrequencyMillis, this.updateFrequencyMillis),
      sourceOrgUrl: this.id,
    };
  }
  
  protected mapWasteEventToOffer(wasteEvent: LpoOprDonation): Offer {
    return new Offer({
      id: `${wasteEvent.locationName}-${wasteEvent.wasteItemName}-${getUuid(this.random)}`,
      description: `${wasteEvent.locationName} ${wasteEvent.wasteItemName} donating ${wasteEvent.wasteEventWeight}${wasteEvent.weightUnit}s of ${wasteEvent.wasteItemName}`,
      notes: 'pick it up by the garage. ask for John Richter.',
      contents: {                   // productbundle.schema.json
        contents: [                 // product.schema.json
          {
            description: wasteEvent.wasteItemName,
            id: "ed35ceeb-6d60-4fca-a116-ecc9cbb1ac62",       // what is this ID used for?
            itemTypeIds: [
              {
                itemId: wasteEvent.wasteItemId,
                vocabularyId: "leanpath waste event id"
              }
            ],
            price: {
              currency: wasteEvent.currencyCode,
              value: wasteEvent.wasteEventValue
            },
            quantity: wasteEvent.wasteItemQuantity,
            unitWeight: {
              dimension: "weight",
              unit: wasteEvent.weightUnit,
              value: wasteEvent.wasteEventWeight
            }
          }
        ],
        description: "pear, apple, ground beef",
        id: "98965ee5-050b-4c6b-9a92-3cce6884f7bf",
        isGrossEstimate: false,
        packagingType: "box",
        price: {
          currency: wasteEvent.currencyCode,
          value: wasteEvent.wasteEventValue
        },
      },
      reshareChain: '',           // resharechain.schema.json
      transportationDetails: '',  // transportationdetails.schema.json
      contactInfo: '',            // offercontact.schema.json
      offeredBy: '',              // get the Location name 
      offerLocation: '',          // offerlocation.schema.json
      offerExpirationUTC: '',     // timestamp.schema.json
      offerCreationUTC: '',       // timestamp.schema.json
      offerUpdateUTC: '',         // timestamp.schema.json
      maxReservationTimeSecs: ''  // integer
    })

  }
}
  
  const DEFAULT_DESC_TEMPLATES = [
    'bottles of beer',
  'mugs of mead',
  'flagons of frangelico',
  'cartons of kombucha',
  'jugs of gin',
  'jars of juice',
  'tubs of tequila',
  'cans of cola',
  'vials of vodka',
  'canteens of clamato',
  'tankards of tea',
  'bottles of beer',
  'measures of milk',
  'snifters of sake',
  'shots of sangria',
  'highballs of hooch',
  'beakers of bourbon',
  'cups of coffee',
  'canisters of campari',
  'pots of pilsner',
  'barrles of brandy',
  'teacups of tonic',
  'goblets of galliano',
  'grails of grey goose',
];

export interface LpoOprDonation {
  wasteEventId: number;
  wasteItemId: number;
  wasteItemQuantity: number;
  wasteItemName: string;
  wasteEventWeight: string;
  weightUnit: string;
  wasteEventValue: number;
  currencyCode: string;
  locationId: number;
  locationName: string;
  siteId: number;
  siteName: string;
  address: string;
  latitude: string;
  longitude: string;
  timeSubmittedMillis: number;
}

export interface LpoOfferProducerOptions {
  /**
   * The odds that, during an update, any given offer will be updated.
   * Values are in the range 0-1. Defaults to .1
   */
  updateChance?: number;

  locationId: number;

  /**
   * The frequency at which offers are updated, in milliseconds. Note that the
   * offer will be updated NO MORE FREQUENTLY than this value. However, updates
   * only occur when the produceOffers() method is called, so the actual update
   * frequency is the maxiumum of this value and the frequency with which the
   * server's ingest() method is called. Default is 5 minutes (in milliseconds).
   */
  updateFrequencyMillis?: number;

  /**
   * The frequency at which offers are created, in milliseconds. Note that
   * offers will be created NO MORE FREQUENTLY than this value. However, offers
   * are only created when the produceOffers() method is called, so the actual
   * frequency is the maxiumum of this value and the frequency with which the
   * server's ingest() method is called. Default is 10 minutes (in
   * milliseconds).
   */
  newItemFrequencyMillis?: number;

  /**
   * The maximum age of offers created by this producer, in milliseconds.
   * Default is 1 day (in milliseconds).
   */
  expirationAgeMillis?: number;

  /**
   * The minimum number of offers this producer will return. Default is 1.
   */
  minOfferCount?: number;

  /**
   * The maximum number of offers this producer will return. Default is 24.
   */
  maxOfferCount?: number;

  /** The clock to use. Defaults to a DefaultClock. */
  clock?: Clock;

  /**
   * The source org url. Used to identify this offer producer and for the
   * offeredBy property of offers.
   */
  sourceOrgUrl: string;

  /**
   * The OPR server's integration client. Normal offer producers do not need a
   * reference to the client, but this fake offer producer needs to look up
   * existing offers to decide when to create/update new offers.
   */
  integrationApi: IntegrationApi;

  /**
   * A random number generator. The caller may provide a random number generator
   * initialized with a particular seed to make this offer producer behave
   * deterministically. Defaults to a randomly seeded generator.
   */
  random?: RandomSeed;

  /**
   * A list of string templates to use for creating new offers. A random value
   * will be chosen from this list to build the offer description and the offer
   * contents descriptions. Defaults to an illiterative list of 24 beverages and
   * containers.
   */
  descTemplates?: Array<string>;
}
