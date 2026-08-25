import React from 'react';
import { Button } from '@razorpay/blade/components';

type DemoUIProps = {
  variant: 'primary' | 'secondary';
};

export const DemoUI = ({ variant }: DemoUIProps): React.ReactElement => (
  <Button variant={variant === 'primary' ? 'primary' : 'secondary'}>Pay now</Button>
);
