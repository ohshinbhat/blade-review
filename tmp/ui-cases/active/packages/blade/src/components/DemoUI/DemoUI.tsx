import React from 'react';
import { Box, Button, Typography } from '@razorpay/blade/components';

/** Clean baseline. Replace this file with a catalog case on a demo branch. */
export const DemoUI = (): React.ReactElement => (
  <Box>
    <Typography>Payment total</Typography>
    <Typography>₹500</Typography>
    <Button variant="tertiary">Pay now</Button>
  </Box>
);
