import React from 'react';
import { Box, Button, Typography } from '@razorpay/blade/components';

/** Clean baseline. Replace this file with a catalog case on a demo branch. */
export const DemoUI = (): React.ReactElement => (
  <Box>
    <Typography>Payment amount</Typography>
    <Typography>₹500</Typography>
    <Button variant="primary">Pay now</Button>
  </Box>
);
