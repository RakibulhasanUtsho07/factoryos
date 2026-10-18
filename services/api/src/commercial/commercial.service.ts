import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  calculateCommercialLines, canTransitionQuotation, convertAmountToBase, decimalScaled, formatScaled,
  normalizeCurrency, type CommercialLineInput, type QuotationStatus,
} from './quotation-lifecycle';
import {
  CreateExchangeRateDto, CreatePricingRuleDto, CreateQuotationDto, ListCommercialRulesDto,
  ListExchangeRatesDto, ListQuotationsDto, ReviseQuotationDto,
} from './dto/quotation.dto';

interface EventContext { requestId: string | null; traceId: string | null; }
interface QuoteRow {
  id: string; tenant_id: string; factory_id: string; quote_number: string; customer_name: string;
  customer_reference: string | null; status: QuotationStatus; current_revision: number; version: string;
  converted_order_id: string | null; created_by_user_id: string; updated_by_user_id: string;
  last_change_reason: string; created_at: string; updated_at: string;
}
interface RuleRow {
  id: string; rule_code: string; customer_reference: string | null; version: number; base_currency: string;
  allowed_currencies: string[]; default_tax_percent: string; max_discount_percent: string;
  approval_required: boolean; approval_total_threshold: string | null;
  approval_discount_threshold_percent: string; incoterms_required: boolean; payment_terms_required: boolean;
}
interface Terms {
  currency: string; baseCurrency: string; rate: string; rateAsOf: string; rateSource: string;
  requestedDeliveryDate: string | null; validUntil: string | null; incoterms: string | null;
  paymentTerms: string | null; notes: string | null; defaultTaxPercent: number; maxDiscountPercent: number;
  approvalRequired: boolean; approvalTotalThreshold: string | null; approvalDiscountThresholdPercent: number;
  ruleId: string | null; ruleVersion: number | null; ruleCode: string; ruleSnapshot: Record<string, unknown>;
  lines: ReturnType<typeof calculateCommercialLines>['lines']; subtotal: string; discounts: string;
  tax: string; total: string; totalBase: string;
}

@Injectable()
export class CommercialService {
  constructor(private readonly database: DatabaseService) {}

  async createQuotation(userId: string, tenantId: string, dto: CreateQuotationDto, idempotencyKey: string | null, ctx: EventContext) {
    this.ids(userId, tenantId, dto.factory_id);
    const quoteNumber = dto.quote_number.trim();
    const customerName = dto.customer_name.trim();
    if (!quoteNumber || !customerName) throw new BadRequestException('Quote number and customer name are required');
    const key = this.idempotencyKey(idempotencyKey);
    const hash = createHash('sha256').update(JSON.stringify(dto)).digest('hex');
    try {
      return await this.database.transaction({ tenantId, userId }, async (client) => {
        await this.activeFactory(client, tenantId, dto.factory_id);
        if (key) {
          const replay = await client.query(
            `SELECT id::text AS id,request_hash FROM sales_quotations
             WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE`,
            [tenantId, dto.factory_id, key],
          );
          const previous = replay.rows[0] as { id: string; request_hash: string } | undefined;
          if (previous) {
            if (previous.request_hash !== hash) throw new ConflictException('Idempotency-Key was reused with a different request');
            return this.loadQuote(client, tenantId, dto.factory_id, previous.id);
          }
        }
        const terms = await this.resolveTerms(client, tenantId, dto.factory_id, dto.customer_reference?.trim() || null,
          dto.pricing_rule_code?.trim() || null, dto.currency ?? 'BDT', dto.requested_delivery_date ?? null,
          dto.valid_until ?? null, dto.incoterms?.trim() || null, dto.payment_terms?.trim() || null,
          dto.notes?.trim() || null, dto.lines);
        const inserted = await client.query(
          `INSERT INTO sales_quotations (
             tenant_id,factory_id,quote_number,customer_name,customer_reference,idempotency_key,request_hash,
             created_by_user_id,updated_by_user_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
           RETURNING id::text AS id`,
          [tenantId,dto.factory_id,quoteNumber,customerName,dto.customer_reference?.trim() || null,key,key ? hash : null,userId],
        );
        const id = String(inserted.rows[0]?.id ?? '');
        if (!id) throw new Error('QUOTATION_INSERT_FAILED');
        await this.insertVersion(client, tenantId, dto.factory_id, id, 1, userId, terms);
        await this.history(client, tenantId, dto.factory_id, id, 1, null, 'DRAFT', 'CREATED', userId,
          'Draft quotation created', ctx, null, { pricing_rule_code: terms.ruleCode });
        await this.event(client, tenantId, dto.factory_id, id, 'QUOTATION.CREATED', {
          quotation_id: id, quote_number: quoteNumber, revision: 1, status: 'DRAFT',
          currency: terms.currency, total: terms.total, total_base: terms.totalBase,
        }, userId, ctx);
        return this.loadQuote(client, tenantId, dto.factory_id, id);
      });
    } catch (error) {
      if (this.pgCode(error) === '23505') throw new ConflictException('Quote number or idempotency key already exists in this factory');
      throw error;
    }
  }

  async reviseQuotation(userId: string, tenantId: string, factoryId: string, quoteId: string, dto: ReviseQuotationDto, ctx: EventContext) {
    this.ids(userId, tenantId, factoryId, quoteId);
    const reason = dto.reason.trim();
    if (!reason || dto.expected_version < 1) throw new BadRequestException('A revision reason and positive expected_version are required');
    return this.database.transaction({ tenantId, userId }, async (client) => {
      const quote = await this.lockQuote(client, tenantId, factoryId, quoteId);
      if (!quote) throw new NotFoundException('Quotation not found');
      this.checkVersion(quote, dto.expected_version);
      if (quote.status !== 'DRAFT' && quote.status !== 'REJECTED') throw new ConflictException('Only draft or rejected quotations can be revised');
      const current = await this.currentTerms(client, tenantId, factoryId, quoteId);
      const terms = await this.resolveTerms(client, tenantId, factoryId, quote.customer_reference,
        dto.pricing_rule_code?.trim() || null, dto.currency ?? current.currency,
        dto.requested_delivery_date === undefined ? current.requested_delivery_date : dto.requested_delivery_date,
        dto.valid_until === undefined ? current.valid_until : dto.valid_until,
        dto.incoterms === undefined ? current.incoterms : dto.incoterms?.trim() || null,
        dto.payment_terms === undefined ? current.payment_terms : dto.payment_terms?.trim() || null,
        dto.notes === undefined ? current.notes : dto.notes?.trim() || null, dto.lines);
      const revision = quote.current_revision + 1;
      await client.query(
        `UPDATE sales_quotations SET status='DRAFT',current_revision=$1,version=version+1,updated_by_user_id=$2,
             last_change_reason=$3,updated_at=clock_timestamp()
         WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND version=$7`,
        [revision,userId,reason,quoteId,tenantId,factoryId,dto.expected_version],
      );
      await this.insertVersion(client,tenantId,factoryId,quoteId,revision,userId,terms);
      await this.history(client,tenantId,factoryId,quoteId,revision,quote.status,'DRAFT','REVISED',userId,reason,ctx,null,
        { previous_revision: quote.current_revision });
      await this.event(client,tenantId,factoryId,quoteId,'QUOTATION.REVISED',{
        quotation_id:quoteId,revision,previous_status:quote.status,status:'DRAFT',
      },userId,ctx);
      return this.loadQuote(client,tenantId,factoryId,quoteId);
    });
  }

  async listQuotationRevisions(userId: string, tenantId: string, factoryId: string, quoteId: string) {
    this.ids(userId,tenantId,factoryId,quoteId);
    return this.database.transaction({tenantId,userId},async (client) => {
      const quote = await client.query(
        'SELECT id::text AS id FROM sales_quotations WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
        [quoteId,tenantId,factoryId],
      );
      if (!quote.rows[0]) throw new NotFoundException('Quotation not found');
      const versions = await client.query(
        `SELECT id::text AS quotation_version_id,revision_number,currency,base_currency,
            exchange_rate_to_base::text AS exchange_rate_to_base,exchange_rate_as_of::text AS exchange_rate_as_of,
            exchange_rate_source,requested_delivery_date::text AS requested_delivery_date,
            valid_until::text AS valid_until,incoterms,payment_terms,notes,
            subtotal::text AS subtotal,discount_total::text AS discount_total,tax_total::text AS tax_total,
            total::text AS total,total_base::text AS total_base,approval_required,
            approval_total_threshold::text AS approval_total_threshold,
            approval_discount_threshold_percent::text AS approval_discount_threshold_percent,
            pricing_rule_code,pricing_rule_version,pricing_rule_snapshot,
            created_by_user_id::text AS created_by_user_id,created_at::text AS created_at
         FROM quotation_versions WHERE quotation_id=$1 AND tenant_id=$2 AND factory_id=$3
         ORDER BY revision_number DESC`,
        [quoteId,tenantId,factoryId],
      );
      const items = [];
      for (const version of versions.rows) {
        const lines = await client.query(
          `SELECT id::text AS id,line_number,product_code,product_name,quantity::text AS quantity,unit,
              unit_price::text AS unit_price,discount_percent::text AS discount_percent,
              tax_percent::text AS tax_percent,line_subtotal::text AS line_subtotal,
              line_discount::text AS line_discount,line_tax::text AS line_tax,
              line_total::text AS line_total,notes
           FROM quotation_lines WHERE tenant_id=$1 AND factory_id=$2 AND quotation_id=$3
             AND quotation_version_id=$4 ORDER BY line_number`,
          [tenantId,factoryId,quoteId,version.quotation_version_id],
        );
        items.push({...version,lines:lines.rows});
      }
      return {quotation_id:quoteId,items};
    });
  }

  async getQuotation(userId: string, tenantId: string, factoryId: string, quoteId: string) {
    this.ids(userId,tenantId,factoryId,quoteId);
    return this.database.transaction({tenantId,userId},async (client) => {
      const quote = await this.loadQuote(client,tenantId,factoryId,quoteId);
      if (!quote) throw new NotFoundException('Quotation not found');
      return quote;
    });
  }

  async listQuotations(userId: string, tenantId: string, factoryId: string, query: ListQuotationsDto) {
    this.ids(userId,tenantId,factoryId);
    const limit = query.limit ?? 20;
    const page = query.page ?? 1;
    const search = query.search?.trim() ? '%' + query.search.trim() + '%' : null;
    return this.database.transaction({tenantId,userId},async (client) => {
      const result = await client.query(
        `SELECT q.id::text AS id,q.quote_number,q.customer_name,q.customer_reference,q.status,q.current_revision,
            q.version::text AS version,q.converted_order_id::text AS converted_order_id,
            q.created_at::text AS created_at,v.currency,v.total::text AS total,v.base_currency,
            v.total_base::text AS total_base,COUNT(*) OVER()::text AS total_count
         FROM sales_quotations q JOIN quotation_versions v ON v.quotation_id=q.id
          AND v.revision_number=q.current_revision AND v.tenant_id=q.tenant_id AND v.factory_id=q.factory_id
         WHERE q.tenant_id=$1 AND q.factory_id=$2 AND ($3::text IS NULL OR q.status=$3)
           AND ($4::text IS NULL OR q.quote_number ILIKE $4 OR q.customer_name ILIKE $4 OR COALESCE(q.customer_reference,'') ILIKE $4)
         ORDER BY q.created_at DESC,q.id DESC LIMIT $5 OFFSET $6`,
        [tenantId,factoryId,query.status ?? null,search,limit,(page-1)*limit],
      );
      const total = result.rows[0] ? Number(result.rows[0].total_count) : 0;
      return { items: result.rows.map(({total_count: _count,...row}) => row),
        pagination: {page,limit,total,total_pages: total ? Math.ceil(total/limit) : 0} };
    });
  }

  async createPricingRule(userId: string, tenantId: string, dto: CreatePricingRuleDto) {
    this.ids(userId,tenantId,dto.factory_id);
    const ruleCode = dto.rule_code.trim().toUpperCase();
    if (!ruleCode) throw new BadRequestException('rule_code is required');
    const baseCurrency = this.currency(dto.base_currency,'base_currency');
    const allowed = [...new Set(dto.allowed_currencies.map((value) => this.currency(value,'allowed_currencies')))];
    if (!allowed.includes(baseCurrency)) throw new BadRequestException('allowed_currencies must include base_currency');
    const customerReference = dto.customer_reference?.trim() || null;
    try {
      return await this.database.transaction({tenantId,userId},async (client) => {
        await this.activeFactory(client,tenantId,dto.factory_id);
        const old = await client.query(
          `SELECT id::text AS id FROM commercial_pricing_rules WHERE tenant_id=$1 AND factory_id=$2
           AND COALESCE(lower(customer_reference),'')=COALESCE(lower($3::text),'') AND is_current FOR UPDATE`,
          [tenantId,dto.factory_id,customerReference],
        );
        if (old.rows[0]) await client.query(
          'UPDATE commercial_pricing_rules SET is_current=false WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
          [old.rows[0].id,tenantId,dto.factory_id],
        );
        const previous = await client.query(
          `SELECT MAX(version)::int AS version FROM commercial_pricing_rules WHERE tenant_id=$1 AND factory_id=$2
           AND rule_code=$3 AND COALESCE(lower(customer_reference),'')=COALESCE(lower($4::text),'')`,
          [tenantId,dto.factory_id,ruleCode,customerReference],
        );
        const version = Number(previous.rows[0]?.version ?? 0) + 1;
        const inserted = await client.query(
          `INSERT INTO commercial_pricing_rules (
            tenant_id,factory_id,rule_code,customer_reference,version,base_currency,allowed_currencies,
            default_tax_percent,max_discount_percent,approval_required,approval_total_threshold,
            approval_discount_threshold_percent,incoterms_required,payment_terms_required,created_by_user_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,rule_code,
            customer_reference,version,base_currency,allowed_currencies,default_tax_percent::text AS default_tax_percent,
            max_discount_percent::text AS max_discount_percent,approval_required,
            approval_total_threshold::text AS approval_total_threshold,
            approval_discount_threshold_percent::text AS approval_discount_threshold_percent,
            incoterms_required,payment_terms_required,is_current,created_at::text AS created_at`,
          [tenantId,dto.factory_id,ruleCode,customerReference,version,baseCurrency,allowed,
            dto.default_tax_percent ?? 0,dto.max_discount_percent ?? 0,dto.approval_required ?? true,
            dto.approval_total_threshold ?? null,dto.approval_discount_threshold_percent ?? 0,
            dto.incoterms_required ?? false,dto.payment_terms_required ?? false,userId],
        );
        const row = inserted.rows[0];
        await this.event(client,tenantId,dto.factory_id,String(row?.id ?? randomUUID()),
          'COMMERCIAL.PRICING_RULE_VERSION_CREATED',{rule_code:ruleCode,version,customer_reference:customerReference},
          userId,{requestId:null,traceId:null});
        return row;
      });
    } catch (error) {
      if (this.pgCode(error) === '23505') throw new ConflictException('Pricing rule version conflicts with an existing commercial rule');
      throw error;
    }
  }

  async listPricingRules(userId: string, tenantId: string, factoryId: string, query: ListCommercialRulesDto) {
    this.ids(userId,tenantId,factoryId);
    const result = await this.database.query(
      `SELECT id::text AS id,rule_code,customer_reference,version,base_currency,allowed_currencies,
         default_tax_percent::text AS default_tax_percent,max_discount_percent::text AS max_discount_percent,
         approval_required,approval_total_threshold::text AS approval_total_threshold,
         approval_discount_threshold_percent::text AS approval_discount_threshold_percent,
         incoterms_required,payment_terms_required,is_current,created_at::text AS created_at
       FROM commercial_pricing_rules WHERE tenant_id=$1 AND factory_id=$2
        AND ($3::text IS NULL OR lower(COALESCE(customer_reference,''))=lower($3))
       ORDER BY COALESCE(customer_reference,''),rule_code,version DESC`,
      [tenantId,factoryId,query.customer_reference?.trim() || null],{tenantId,userId},
    );
    return {items:result.rows};
  }

  async createExchangeRate(userId: string, tenantId: string, dto: CreateExchangeRateDto) {
    this.ids(userId,tenantId,dto.factory_id);
    const currency = this.currency(dto.currency,'currency');
    const baseCurrency = this.currency(dto.base_currency,'base_currency');
    if (currency === baseCurrency) throw new BadRequestException('Currency and base_currency must differ');
    if (!Number.isFinite(dto.rate_to_base) || dto.rate_to_base <= 0) throw new BadRequestException('rate_to_base must be positive');
    try {
      return await this.database.transaction({tenantId,userId},async (client) => {
        await this.activeFactory(client,tenantId,dto.factory_id);
        const inserted = await client.query(
          `INSERT INTO commercial_exchange_rates (
             tenant_id,factory_id,base_currency,quote_currency,rate_to_base,effective_on,source,created_by_user_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id::text AS id,base_currency AS currency,quote_currency AS base_currency,
             rate_to_base::text AS rate_to_base,effective_on::text AS effective_on,source,created_at::text AS created_at`,
          [tenantId,dto.factory_id,currency,baseCurrency,dto.rate_to_base.toFixed(10),dto.effective_on,dto.source.trim(),userId],
        );
        const row = inserted.rows[0];
        await this.event(client,tenantId,dto.factory_id,String(row?.id ?? randomUUID()),
          'COMMERCIAL.EXCHANGE_RATE_RECORDED',{currency,base_currency:baseCurrency,rate_to_base:dto.rate_to_base.toFixed(10),
            effective_on:dto.effective_on,source:dto.source.trim()},userId,{requestId:null,traceId:null});
        return row;
      });
    } catch (error) {
      if (this.pgCode(error) === '23505') throw new ConflictException('An exchange rate already exists for this pair, date and source');
      throw error;
    }
  }

  async listExchangeRates(userId: string, tenantId: string, factoryId: string, query: ListExchangeRatesDto) {
    this.ids(userId,tenantId,factoryId);
    const currency = query.currency ? this.currency(query.currency,'currency') : null;
    const baseCurrency = query.base_currency ? this.currency(query.base_currency,'base_currency') : null;
    const result = await this.database.query(
      `SELECT id::text AS id,base_currency AS currency,quote_currency AS base_currency,
          rate_to_base::text AS rate_to_base,effective_on::text AS effective_on,source,created_at::text AS created_at
       FROM commercial_exchange_rates WHERE tenant_id=$1 AND factory_id=$2
        AND ($3::text IS NULL OR base_currency=$3) AND ($4::text IS NULL OR quote_currency=$4)
       ORDER BY effective_on DESC,created_at DESC,id DESC`,
      [tenantId,factoryId,currency,baseCurrency],{tenantId,userId},
    );
    return {items:result.rows};
  }

  async transitionQuotation(userId: string, tenantId: string, factoryId: string, quoteId: string,
    action: 'SUBMIT'|'APPROVE'|'REJECT'|'SEND'|'ACCEPT'|'CANCEL', expectedVersion: number,
    reason: string, ctx: EventContext) {
    this.ids(userId,tenantId,factoryId,quoteId);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || !reason.trim()) {
      throw new BadRequestException('expected_version and a non-empty reason are required');
    }
    return this.database.transaction({tenantId,userId},async (client) => {
      const quote = await this.lockQuote(client,tenantId,factoryId,quoteId);
      if (!quote) throw new NotFoundException('Quotation not found');
      this.checkVersion(quote,expectedVersion);
      const current = await this.currentTerms(client,tenantId,factoryId,quoteId);
      let nextStatus: QuotationStatus = quote.status;
      let historyAction: string = action;
      switch (action) {
        case 'SUBMIT':
          if (quote.status !== 'DRAFT') throw new ConflictException('Only a draft quotation can be submitted');
          if (await this.dateExpired(client, current.valid_until)) {
            throw new ConflictException('Quotation validity date has expired');
          }
          if (current.pricing_rule_snapshot.incoterms_required === true && !current.incoterms) {
            throw new BadRequestException('Active pricing rule requires incoterms before submission');
          }
          if (current.pricing_rule_snapshot.payment_terms_required === true && !current.payment_terms) {
            throw new BadRequestException('Active pricing rule requires payment terms before submission');
          }
          nextStatus = current.approval_required ? 'PENDING_APPROVAL' : 'APPROVED';
          historyAction = current.approval_required ? 'SUBMITTED' : 'AUTO_APPROVED';
          break;
        case 'APPROVE':
          if (quote.status !== 'PENDING_APPROVAL') throw new ConflictException('Only pending quotations can be approved');
          if (quote.created_by_user_id === userId) throw new ForbiddenException('Quotation creator cannot approve their own quotation');
          nextStatus = 'APPROVED'; historyAction = 'APPROVED'; break;
        case 'REJECT':
          if (quote.status !== 'PENDING_APPROVAL') throw new ConflictException('Only pending quotations can be rejected');
          if (quote.created_by_user_id === userId) throw new ForbiddenException('Quotation creator cannot reject their own quotation');
          nextStatus = 'REJECTED'; historyAction = 'REJECTED'; break;
        case 'SEND':
          if (quote.status !== 'APPROVED') throw new ConflictException('Only approved quotations can be sent');
          if (await this.dateExpired(client,current.valid_until)) throw new ConflictException('Quotation validity date has expired');
          nextStatus = 'SENT'; historyAction = 'SENT'; break;
        case 'ACCEPT':
          if (quote.status !== 'SENT') throw new ConflictException('Only sent quotations can be accepted');
          if (await this.dateExpired(client, current.valid_until)) {
            throw new ConflictException('Quotation validity date has expired');
          }
          nextStatus = 'ACCEPTED'; historyAction = 'ACCEPTED'; break;
        case 'CANCEL':
          nextStatus = 'CANCELLED'; historyAction = 'CANCELLED'; break;
      }
      if (!canTransitionQuotation(quote.status,nextStatus)) throw new ConflictException('Invalid quotation transition: ' + quote.status + ' -> ' + nextStatus);
      const changed = await client.query(
        `UPDATE sales_quotations SET status=$1,version=version+1,updated_by_user_id=$2,last_change_reason=$3,
           updated_at=clock_timestamp() WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND version=$7 RETURNING id`,
        [nextStatus,userId,reason.trim(),quoteId,tenantId,factoryId,expectedVersion],
      );
      if (!changed.rows[0]) throw new ConflictException('Quotation changed during lifecycle transition');
      await this.history(client,tenantId,factoryId,quoteId,quote.current_revision,quote.status,nextStatus,
        historyAction,userId,reason.trim(),ctx,null,{});
      await this.event(client,tenantId,factoryId,quoteId,'QUOTATION.'+historyAction,{
        quotation_id:quoteId,revision:quote.current_revision,from_status:quote.status,to_status:nextStatus,
      },userId,ctx);
      return this.loadQuote(client,tenantId,factoryId,quoteId);
    });
  }

  async convertAcceptedQuotation(userId: string, tenantId: string, factoryId: string, quoteId: string,
    orderNumber: string, expectedVersion: number, reason: string, ctx: EventContext) {
    this.ids(userId,tenantId,factoryId,quoteId);
    if (!orderNumber.trim() || !reason.trim() || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new BadRequestException('order_number, reason and positive expected_version are required');
    }
    try {
      return await this.database.transaction({tenantId,userId},async (client) => {
        const quote = await this.lockQuote(client,tenantId,factoryId,quoteId);
        if (!quote) throw new NotFoundException('Quotation not found');
        if (quote.status === 'CONVERTED' && quote.converted_order_id) {
          const replay = await client.query(
            'SELECT id::text AS id,order_number FROM orders WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
            [quote.converted_order_id,tenantId,factoryId],
          );
          if (replay.rows[0]?.order_number === orderNumber.trim()) {
            return {replayed:true,order:replay.rows[0],quotation:await this.loadQuote(client,tenantId,factoryId,quoteId)};
          }
          throw new ConflictException('Quotation has already been converted');
        }
        this.checkVersion(quote,expectedVersion);
        if (quote.status !== 'ACCEPTED') throw new ConflictException('Only accepted quotations can be converted');
        const current = await this.currentTerms(client,tenantId,factoryId,quoteId);
        if (await this.dateExpired(client, current.valid_until)) {
          throw new ConflictException('Quotation validity date has expired');
        }
        const created = await client.query(
          `INSERT INTO orders (tenant_id,factory_id,order_number,customer_name,customer_reference,status,order_date,
             requested_delivery_date,currency,notes,created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,'DRAFT',CURRENT_DATE,$6,$7,$8,$9)
           RETURNING id::text AS id,order_number,status,currency,order_date::text AS order_date`,
          [tenantId,factoryId,orderNumber.trim(),quote.customer_name,quote.customer_reference,
            current.requested_delivery_date,current.currency,'Converted from '+quote.quote_number+' revision '+quote.current_revision,userId],
        );
        const order = created.rows[0];
        if (!order) throw new Error('ORDER_INSERT_FAILED');
        const lines = await client.query(
          `SELECT line_number,product_code,product_name,quantity::text AS quantity,unit,unit_price::text AS unit_price,notes
           FROM quotation_lines WHERE tenant_id=$1 AND factory_id=$2 AND quotation_id=$3 AND quotation_version_id=(
             SELECT id FROM quotation_versions WHERE quotation_id=$3 AND revision_number=$4 AND tenant_id=$1 AND factory_id=$2
           ) ORDER BY line_number`,
          [tenantId,factoryId,quoteId,quote.current_revision],
        );
        for (const line of lines.rows) await client.query(
          `INSERT INTO order_lines (tenant_id,factory_id,order_id,line_number,product_code,product_name,quantity,unit,unit_price,requested_delivery_date,notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [tenantId,factoryId,order.id,line.line_number,line.product_code,line.product_name,line.quantity,line.unit,
            line.unit_price,current.requested_delivery_date,line.notes],
        );
        const changed = await client.query(
          `UPDATE sales_quotations SET status='CONVERTED',converted_order_id=$1,version=version+1,
             updated_by_user_id=$2,last_change_reason=$3,updated_at=clock_timestamp()
           WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND version=$7 AND status='ACCEPTED' RETURNING id`,
          [order.id,userId,reason.trim(),quoteId,tenantId,factoryId,expectedVersion],
        );
        if (!changed.rows[0]) throw new ConflictException('Quotation changed during conversion');
        await this.history(client,tenantId,factoryId,quoteId,quote.current_revision,'ACCEPTED','CONVERTED','CONVERTED',
          userId,reason.trim(),ctx,String(order.id),{
            order_number:orderNumber.trim(),order_id:order.id,revision:quote.current_revision,
            currency:current.currency,quoted_total:current.total,quoted_total_base:current.total_base,
          });
        await this.event(client,tenantId,factoryId,quoteId,'QUOTATION.CONVERTED',{
          quotation_id:quoteId,order_id:order.id,order_number:orderNumber.trim(),revision:quote.current_revision,
          currency:current.currency,total:current.total,total_base:current.total_base,
        },userId,ctx);
        await this.event(client,tenantId,factoryId,String(order.id),'ORDER.CREATED_FROM_QUOTATION',{
          order_id:order.id,order_number:orderNumber.trim(),quotation_id:quoteId,quote_number:quote.quote_number,
          revision:quote.current_revision,currency:current.currency,
        },userId,ctx);
        return {replayed:false,order,quotation:await this.loadQuote(client,tenantId,factoryId,quoteId)};
      });
    } catch (error) {
      if (this.pgCode(error) === '23505') throw new ConflictException('Order number already exists in this tenant');
      throw error;
    }
  }

  private async resolveTerms(client: PoolClient, tenantId: string, factoryId: string, customerRef: string|null,
    requestedRule: string|null, rawCurrency: string, delivery: string|null, validUntil: string|null,
    incoterms: string|null, paymentTerms: string|null, notes: string|null, inputLines: CommercialLineInput[]): Promise<Terms> {
    const result = await client.query<RuleRow>(
      `SELECT id::text AS id,rule_code,customer_reference,version,base_currency,allowed_currencies,
          default_tax_percent::text AS default_tax_percent,max_discount_percent::text AS max_discount_percent,
          approval_required,approval_total_threshold::text AS approval_total_threshold,
          approval_discount_threshold_percent::text AS approval_discount_threshold_percent,
          incoterms_required,payment_terms_required
       FROM commercial_pricing_rules WHERE tenant_id=$1 AND factory_id=$2 AND is_current=true
        AND (COALESCE(lower(customer_reference),'')=COALESCE(lower($3::text),'') OR customer_reference IS NULL)
        AND ($4::text IS NULL OR rule_code=$4)
       ORDER BY CASE WHEN customer_reference IS NOT NULL THEN 0 ELSE 1 END,version DESC,created_at DESC LIMIT 1`,
      [tenantId,factoryId,customerRef,requestedRule],
    );
    const rule = result.rows[0];
    if (await this.dateExpired(client,validUntil)) throw new BadRequestException('valid_until must not be in the past');
    if (requestedRule && !rule) throw new BadRequestException('Requested pricing rule is not active for this customer and factory');
    const ruleCode = rule?.rule_code ?? 'DEFAULT_BDT';
    const baseCurrency = this.currency(rule?.base_currency ?? 'BDT','base_currency');
    const currency = this.currency(rawCurrency,'currency');
    const allowed = rule?.allowed_currencies ?? ['BDT'];
    if (!allowed.includes(currency)) throw new BadRequestException('Currency is not allowed by active pricing rule '+ruleCode);
    const defaultTax = Number(rule?.default_tax_percent ?? 0);
    const maximumDiscount = Number(rule?.max_discount_percent ?? 0);
    if (rule?.incoterms_required && !incoterms) throw new BadRequestException('Pricing rule requires incoterms');
    if (rule?.payment_terms_required && !paymentTerms) throw new BadRequestException('Pricing rule requires payment terms');
    const calculated = calculateCommercialLines(inputLines,defaultTax,maximumDiscount);
    const fx = await this.fxRate(client,tenantId,factoryId,currency,baseCurrency);
    const total = formatScaled(calculated.totals.total_scaled,4);
    const totalBase = convertAmountToBase(calculated.totals.total_scaled,fx.rate);
    const threshold = rule?.approval_total_threshold ? String(rule.approval_total_threshold) : null;
    const approvedByThreshold = threshold !== null && decimalScaled(totalBase,4) >= decimalScaled(threshold,4);
    const approvedByDiscount = calculated.maxLineDiscountPercent > Number(rule?.approval_discount_threshold_percent ?? 0);
    const approvalRequired = (rule?.approval_required ?? true) || approvedByThreshold || approvedByDiscount;
    return {
      currency,baseCurrency,rate:fx.rate,rateAsOf:fx.asOf,rateSource:fx.source,
      requestedDeliveryDate:delivery,validUntil,incoterms,paymentTerms,notes,defaultTaxPercent:defaultTax,
      maxDiscountPercent:maximumDiscount,approvalRequired,approvalTotalThreshold:threshold,
      approvalDiscountThresholdPercent:Number(rule?.approval_discount_threshold_percent ?? 0),
      ruleId:rule?.id ?? null,ruleVersion:rule?.version ?? null,ruleCode,
      ruleSnapshot:{
        rule_code:ruleCode,rule_version:rule?.version ?? null,customer_reference:rule?.customer_reference ?? null,
        base_currency:baseCurrency,allowed_currencies:allowed,default_tax_percent:defaultTax,
        max_discount_percent:maximumDiscount,approval_required_by_rule:rule?.approval_required ?? true,
        approval_total_threshold:threshold,approval_discount_threshold_percent:Number(rule?.approval_discount_threshold_percent ?? 0),
        incoterms_required:rule?.incoterms_required ?? false,payment_terms_required:rule?.payment_terms_required ?? false,
        resolved_approval_required:approvalRequired,
      },
      lines:calculated.lines,subtotal:formatScaled(calculated.totals.subtotal_scaled,4),
      discounts:formatScaled(calculated.totals.discount_scaled,4),tax:formatScaled(calculated.totals.tax_scaled,4),
      total,totalBase,
    };
  }

  private async dateExpired(client: PoolClient, value: string | null) {
    if (!value) return false;
    const result = await client.query<{expired:boolean}>('SELECT $1::date < CURRENT_DATE AS expired', [value]);
    return result.rows[0]?.expired ?? false;
  }

  private async fxRate(client: PoolClient, tenantId: string, factoryId: string, currency: string, baseCurrency: string) {
    if (currency === baseCurrency) {
      const today = await client.query<{as_of:string}>('SELECT CURRENT_DATE::text AS as_of');
      return {rate:'1.0000000000',asOf:today.rows[0]?.as_of ?? '1970-01-01',source:'IDENTITY'};
    }
    const result = await client.query(
      `SELECT rate_to_base::text AS rate,effective_on::text AS as_of,source FROM commercial_exchange_rates
       WHERE tenant_id=$1 AND factory_id=$2 AND base_currency=$3 AND quote_currency=$4 AND effective_on<=CURRENT_DATE
       ORDER BY effective_on DESC,created_at DESC,id DESC LIMIT 1`,
      [tenantId,factoryId,currency,baseCurrency],
    );
    const row = result.rows[0] as {rate:string;as_of:string;source:string}|undefined;
    if (!row) throw new BadRequestException('No effective exchange rate is available from '+currency+' to '+baseCurrency);
    return {rate:row.rate,asOf:row.as_of,source:row.source};
  }

  private async insertVersion(client: PoolClient, tenantId: string, factoryId: string, quoteId: string,
    revision: number, userId: string, t: Terms) {
    const inserted = await client.query(
      `INSERT INTO quotation_versions (
        tenant_id,factory_id,quotation_id,revision_number,currency,base_currency,exchange_rate_to_base,
        exchange_rate_as_of,exchange_rate_source,requested_delivery_date,valid_until,incoterms,payment_terms,notes,
        subtotal,discount_total,tax_total,total,total_base,default_tax_percent,max_discount_percent,approval_required,
        approval_total_threshold,approval_discount_threshold_percent,pricing_rule_id,pricing_rule_version,
        pricing_rule_code,pricing_rule_snapshot,created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29)
       RETURNING id::text AS id`,
      [tenantId,factoryId,quoteId,revision,t.currency,t.baseCurrency,t.rate,t.rateAsOf,t.rateSource,
        t.requestedDeliveryDate,t.validUntil,t.incoterms,t.paymentTerms,t.notes,t.subtotal,t.discounts,t.tax,t.total,t.totalBase,
        t.defaultTaxPercent,t.maxDiscountPercent,t.approvalRequired,t.approvalTotalThreshold,
        t.approvalDiscountThresholdPercent,t.ruleId,t.ruleVersion,t.ruleCode,JSON.stringify(t.ruleSnapshot),userId],
    );
    const versionId = String(inserted.rows[0]?.id ?? '');
    if (!versionId) throw new Error('QUOTATION_VERSION_INSERT_FAILED');
    for (const line of t.lines) await client.query(
      `INSERT INTO quotation_lines (
        tenant_id,factory_id,quotation_id,quotation_version_id,line_number,product_code,product_name,quantity,
        unit,unit_price,discount_percent,tax_percent,line_subtotal,line_discount,line_tax,line_total,notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [tenantId,factoryId,quoteId,versionId,line.line_number,line.product_code,line.product_name,line.quantity,line.unit,
        line.unit_price,line.discount_percent,line.tax_percent,line.line_subtotal,line.line_discount,line.line_tax,line.line_total,line.notes],
    );
  }

  private async loadQuote(client: PoolClient, tenantId: string, factoryId: string, quoteId: string) {
    const result = await client.query(
      `SELECT q.id::text AS id,q.tenant_id::text AS tenant_id,q.factory_id::text AS factory_id,q.quote_number,
        q.customer_name,q.customer_reference,q.status,q.current_revision,q.version::text AS version,
        q.converted_order_id::text AS converted_order_id,q.created_by_user_id::text AS created_by_user_id,
        q.updated_by_user_id::text AS updated_by_user_id,q.last_change_reason,q.created_at::text AS created_at,
        q.updated_at::text AS updated_at,v.id::text AS quotation_version_id,v.currency,v.base_currency,
        v.exchange_rate_to_base::text AS exchange_rate_to_base,v.exchange_rate_as_of::text AS exchange_rate_as_of,
        v.exchange_rate_source,v.requested_delivery_date::text AS requested_delivery_date,v.valid_until::text AS valid_until,
        v.incoterms,v.payment_terms,v.notes,v.subtotal::text AS subtotal,v.discount_total::text AS discount_total,
        v.tax_total::text AS tax_total,v.total::text AS total,v.total_base::text AS total_base,v.approval_required,
        v.approval_total_threshold::text AS approval_total_threshold,
        v.approval_discount_threshold_percent::text AS approval_discount_threshold_percent,
        v.pricing_rule_code,v.pricing_rule_version,v.pricing_rule_snapshot
       FROM sales_quotations q JOIN quotation_versions v ON v.quotation_id=q.id AND v.revision_number=q.current_revision
        AND v.tenant_id=q.tenant_id AND v.factory_id=q.factory_id
       WHERE q.id=$1 AND q.tenant_id=$2 AND q.factory_id=$3`,
      [quoteId,tenantId,factoryId],
    );
    const header = result.rows[0];
    if (!header) return null;
    const lines = await client.query(
      `SELECT id::text AS id,line_number,product_code,product_name,quantity::text AS quantity,unit,
        unit_price::text AS unit_price,discount_percent::text AS discount_percent,tax_percent::text AS tax_percent,
        line_subtotal::text AS line_subtotal,line_discount::text AS line_discount,line_tax::text AS line_tax,
        line_total::text AS line_total,notes FROM quotation_lines
       WHERE tenant_id=$1 AND factory_id=$2 AND quotation_id=$3 AND quotation_version_id=$4 ORDER BY line_number`,
      [tenantId,factoryId,quoteId,header.quotation_version_id],
    );
    const history = await client.query(
      `SELECT id::text AS id,revision_number,from_status,to_status,action,actor_user_id::text AS actor_user_id,
        reason,request_id::text AS request_id,trace_id::text AS trace_id,order_id::text AS order_id,details,created_at::text AS created_at
       FROM quotation_history WHERE tenant_id=$1 AND factory_id=$2 AND quotation_id=$3 ORDER BY created_at,id`,
      [tenantId,factoryId,quoteId],
    );
    return {...header,lines:lines.rows,history:history.rows};
  }

  private async currentTerms(client: PoolClient, tenantId: string, factoryId: string, quoteId: string) {
    const result = await client.query(
      `SELECT v.currency,v.base_currency,v.valid_until::text AS valid_until,v.requested_delivery_date::text AS requested_delivery_date,
        v.notes,v.incoterms,v.payment_terms,v.total::text AS total,v.total_base::text AS total_base,
        v.approval_required,v.pricing_rule_snapshot
       FROM sales_quotations q JOIN quotation_versions v ON v.quotation_id=q.id AND v.revision_number=q.current_revision
       WHERE q.id=$1 AND q.tenant_id=$2 AND q.factory_id=$3`,
      [quoteId,tenantId,factoryId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Current quotation version not found');
    return row as {
      currency:string;base_currency:string;valid_until:string|null;requested_delivery_date:string|null;
      notes:string|null;incoterms:string|null;payment_terms:string|null;total:string;total_base:string;
      approval_required:boolean;pricing_rule_snapshot:Record<string,unknown>;
    };
  }

  private async lockQuote(client: PoolClient, tenantId: string, factoryId: string, quoteId: string): Promise<QuoteRow|null> {
    const result = await client.query<QuoteRow>(
      `SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,quote_number,customer_name,
        customer_reference,status,current_revision,version::text AS version,converted_order_id::text AS converted_order_id,
        created_by_user_id::text AS created_by_user_id,updated_by_user_id::text AS updated_by_user_id,
        last_change_reason,created_at::text AS created_at,updated_at::text AS updated_at
       FROM sales_quotations WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
      [quoteId,tenantId,factoryId],
    );
    return result.rows[0] ?? null;
  }

  private async activeFactory(client: PoolClient, tenantId: string, factoryId: string) {
    const result = await client.query('SELECT 1 FROM factories WHERE id=$1 AND tenant_id=$2 AND status=$3', [factoryId,tenantId,'ACTIVE']);
    if (!result.rows[0]) throw new ForbiddenException('Factory is not active or not scoped to the authenticated tenant');
  }

  private async history(client: PoolClient, tenantId: string, factoryId: string, quoteId: string, revision: number,
    fromStatus: QuotationStatus|null, toStatus: QuotationStatus, action: string, userId: string, reason: string,
    ctx: EventContext, orderId: string|null, details: Record<string,unknown>) {
    await client.query(
      `INSERT INTO quotation_history (tenant_id,factory_id,quotation_id,revision_number,from_status,to_status,action,
        actor_user_id,reason,request_id,trace_id,order_id,details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [tenantId,factoryId,quoteId,revision,fromStatus,toStatus,action,userId,reason,this.uuidOrNull(ctx.requestId),
        this.uuidOrNull(ctx.traceId),orderId,JSON.stringify(details)],
    );
  }

  private async event(client: PoolClient, tenantId: string, factoryId: string, aggregateId: string, eventType: string,
    payload: Record<string,unknown>, userId: string, ctx: EventContext) {
    await client.query(
      `INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,occurred_at,
        correlation_id,causation_id,actor,source,payload)
       VALUES ($1,$2,'COMMERCIAL',$3,$4,1,clock_timestamp(),$5,NULL,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [tenantId,factoryId,aggregateId,eventType,this.uuidOrNull(ctx.traceId) ?? this.uuidOrNull(ctx.requestId) ?? randomUUID(),
        JSON.stringify({type:'user',id:userId}),JSON.stringify({system:'FactoryOS',connector:'commercial-service',
          version:process.env.APP_VERSION ?? '0.0.1'}),JSON.stringify(payload)],
    );
  }

  private ids(userId: string, tenantId: string, factoryId?: string, quoteId?: string) {
    this.uuid(userId,'userId'); this.uuid(tenantId,'tenantId');
    if (factoryId) this.uuid(factoryId,'factoryId');
    if (quoteId) this.uuid(quoteId,'quotationId');
  }
  private uuid(value: string, field: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new BadRequestException(field+' must be a valid UUID');
    }
  }
  private currency(value: string, field: string) {
    try { return normalizeCurrency(value,field); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : field+' is invalid'); }
  }
  private idempotencyKey(value: string|null) {
    if (value === null || value === undefined) return null;
    const key = value.trim();
    if (!key || key.length > 255) throw new BadRequestException('Idempotency-Key must contain 1 to 255 characters');
    return key;
  }
  private checkVersion(quote: QuoteRow, expected: number) {
    if (Number(quote.version) !== expected) throw new ConflictException('Quotation version conflict');
  }
  private uuidOrNull(value: string|null|undefined) {
    if (!value) return null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
  }
  private pgCode(error: unknown) {
    return error && typeof error === 'object' && 'code' in error
      ? String((error as {code?:unknown}).code ?? '') : '';
  }
}
