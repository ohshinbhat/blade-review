import React from 'react';
import { Button, Link } from '@razorpay/blade/components';

export const DemoUI = (): React.ReactElement => (
  <Button variant="tertiary">
    <Link href="/help">Help</Link>
  </Button>
);
