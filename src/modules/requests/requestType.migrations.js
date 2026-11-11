import WorkflowDefinition from '../../models/WorkflowDefinition.js';

export const migratePurchaseAmountSemantic = async ({ organizationId, dryRun = false } = {}) => {
  const filter = { definitionType: 'REQUEST_TYPE', code: /^PURCHASE$/i };
  if (organizationId) filter.organizationId = organizationId;
  const definitions = await WorkflowDefinition.find(filter)
    .select('_id organizationId definitionType code fields');
  const result = { scanned: definitions.length, migrated: 0, alreadyConfigured: 0, skipped: 0 };

  for (const definition of definitions) {
    const amountFields = definition.fields.filter((field) => field.semantic === 'AMOUNT');
    const candidates = definition.fields.filter(
      (field) => field.key === 'estimatedCost' && field.type === 'NUMBER' && field.required === true
    );
    if (candidates.length !== 1 || amountFields.some((field) => field.key !== 'estimatedCost')) {
      result.skipped += 1;
      continue;
    }

    const amountField = candidates[0];
    if (amountField.semantic === 'AMOUNT') {
      result.alreadyConfigured += 1;
      continue;
    }
    if (amountFields.length) {
      result.skipped += 1;
      continue;
    }

    result.migrated += 1;
    if (!dryRun) {
      amountField.semantic = 'AMOUNT';
      await definition.save();
    }
  }

  return result;
};
