import { useState } from 'react';

import {
  CodeBlock,
  KeyValueList,
  SectionDivider,
  type TabItem,
  Tabs,
} from '@lincyaw/aegis-ui';

import type { SftRowBase } from '../schemas';

import './SftRowDetail.css';

interface SftRowDetailProps {
  row: SftRowBase;
}

function tryPrettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export function SftRowDetail({ row }: SftRowDetailProps) {
  const items: TabItem[] = [
    { key: 'user', label: 'Input · user' },
    { key: 'system', label: 'Input · system' },
    { key: 'target', label: 'Target' },
    { key: 'meta', label: 'Meta' },
  ];
  const [active, setActive] = useState('user');

  return (
    <div className='llmh-sft-row'>
      <KeyValueList
        items={[
          { k: 'phase', v: row.phase },
          { k: 'sample_id', v: row.sample_id },
          { k: 'session_id', v: row.session_id },
          { k: 'turn_index', v: row.turn_index },
        ]}
      />
      <SectionDivider>SFT shape</SectionDivider>
      <Tabs items={items} activeKey={active} onChange={setActive}>
        {active === 'user' && (
          <CodeBlock language='json' code={tryPrettyJson(row.input.user)} />
        )}
        {active === 'system' && (
          <CodeBlock language='text' code={row.input.system} />
        )}
        {active === 'target' && (
          <CodeBlock
            language='json'
            code={JSON.stringify(row.target, null, 2)}
          />
        )}
        {active === 'meta' && (
          <CodeBlock
            language='json'
            code={JSON.stringify(row.meta ?? {}, null, 2)}
          />
        )}
      </Tabs>
    </div>
  );
}
